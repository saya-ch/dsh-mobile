//! First-party authenticated iroh byte carrier. No DSH credentials or approval
//! decisions are accepted by the sidecar; the target gateway owns application authorization.

mod operator_config;
mod preferences;
mod tls;

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use clap::{Parser, Subcommand};
use dsh_mobile_iroh_core::{
    create_private_directory, decode_wire, encode_wire, open_private_lock_file, pair_fail_text,
    read_line_bounded, read_private_file, validate_device_name, write_line, write_private, Wire,
    ALPN, MAX_UNPAIRED_LINE, PAIR_BAD_CODE, PAIR_EXPIRED, PAIR_NO_WINDOW, PAIR_TOO_MANY_ATTEMPTS,
};
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointAddr, EndpointId, TransportAddr};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio::time::timeout;

const STDIO_VERSION: u8 = 1;
const MAX_STDIN_LINE: usize = 16 * 1024;
const MAX_STORE_BYTES: usize = 128 * 1024;
// A full roster with 64-character Unicode names still fits the 16 KiB stdio event limit.
const MAX_DEVICES: usize = 32;
const MAX_CONNECTIONS: usize = 32;
const MAX_PROXY_STREAMS: usize = 32;
const MAX_GLOBAL_PROXY_STREAMS: usize = 256;
const HANDSHAKE_BUDGET: Duration = Duration::from_secs(10);
const CONNECT_BUDGET: Duration = Duration::from_secs(15);
const PROXY_OPEN_BUDGET: Duration = Duration::from_secs(5);
const PAIRING_TTL: Duration = Duration::from_secs(600);
const PAIRING_MAX_ATTEMPTS: u32 = 3;

#[derive(Parser)]
#[command(
    name = "dsh-mobile-iroh-host",
    about = "Authenticated iroh byte carrier"
)]
struct Cli {
    #[arg(long, global = true, default_value = "en", value_parser = ["zh", "en"])]
    lang: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Host {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        #[arg(long)]
        pair: bool,
        #[arg(long)]
        proxy_target: Option<SocketAddr>,
        /// Disable relay and discovery, and bind iroh to loopback only.
        #[arg(long)]
        local_only: bool,
    },
    PhoneSim {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        #[arg(long)]
        peer: EndpointId,
        /// Explicit direct addresses; the endpoint identity remains TLS authenticated.
        #[arg(long)]
        peer_address: Vec<SocketAddr>,
        #[arg(long)]
        code: Option<String>,
        #[arg(long, default_value = "phone-sim")]
        name: String,
        #[arg(long)]
        proxy_listen: Option<SocketAddr>,
        #[arg(long)]
        local_only: bool,
    },
    Id {
        #[arg(long)]
        data_dir: Option<PathBuf>,
    },
    /// Read only the fixed private startup preference; does not launch iroh.
    PreferenceLoad {
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// Persist the fixed private startup preference; does not launch iroh.
    PreferenceSave {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, required = true, action = clap::ArgAction::Set)]
        enabled: bool,
    },
    /// Prepare fixed durable CA and endpoint certificate without launching iroh.
    TlsPrepare {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value_t = 90)]
        leaf_validity_days: u16,
        #[arg(long, default_value_t = 30)]
        renew_before_days: u16,
        #[arg(long)]
        hold: bool,
        #[arg(long, default_value_t = 60000, value_parser = clap::value_parser!(u64).range(1..=60000))]
        lease_timeout_ms: u64,
    },
    /// Renew only the leaf, retaining the CA and endpoint identity.
    TlsRenew {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value_t = 90)]
        leaf_validity_days: u16,
        #[arg(long, default_value_t = 30)]
        renew_before_days: u16,
        #[arg(long)]
        hold: bool,
        #[arg(long, default_value_t = 60000, value_parser = clap::value_parser!(u64).range(1..=60000))]
        lease_timeout_ms: u64,
    },
    /// Read safe metadata for a complete fixed TLS state.
    TlsStatus {
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// Load only the fixed, nonsecret operator startup settings.
    OperatorConfigLoad {
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// Save only canonical upstream and transport choices; accepts no DSH token.
    OperatorConfigSave {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        upstream_origin: String,
        #[arg(long)]
        local_port: u16,
        #[arg(long, required = true, action = clap::ArgAction::Set)]
        local_only: bool,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginCommand {
    version: u8,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, deserialize_with = "present_text")]
    id: Option<String>,
}

fn present_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

enum PluginIn {
    PairingBegin,
    DeviceList,
    DeviceForget { id: String },
    Shutdown,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TlsRelease {
    version: u8,
    #[serde(rename = "type")]
    kind: String,
}

async fn wait_tls_release(deadline: Duration) -> Result<()> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // Tokio stdin owns an uncancellable blocking-pool read, which would keep
    // runtime shutdown waiting after this command's lease deadline. This bounded
    // reader belongs only to the one-shot native process and ends with it.
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            use std::io::Read as _;
            let mut input = std::io::stdin().lock();
            let mut bytes = Vec::new();
            loop {
                let mut byte = [0u8; 1];
                input.read_exact(&mut byte)?;
                if byte[0] == b'\n' {
                    break;
                }
                if bytes.len() == 128 {
                    bail!("TLS release exceeds byte limit");
                }
                bytes.push(byte[0]);
            }
            let release: TlsRelease = serde_json::from_slice(&bytes)?;
            if release.version != 1 || release.kind != "tls-release" {
                bail!("invalid TLS lease release");
            }
            Ok(())
        })();
        let _ = sender.send(result);
    });
    timeout(deadline, receiver).await??
}

fn decode_command(line: &str) -> Result<PluginIn> {
    if line.len() > MAX_STDIN_LINE {
        bail!("stdio command exceeds byte limit");
    }
    let m: PluginCommand = serde_json::from_str(line).context("invalid stdio command")?;
    if m.version != STDIO_VERSION {
        bail!("unsupported stdio version");
    }
    match (m.kind.as_str(), m.id) {
        ("pairing-begin", None) => Ok(PluginIn::PairingBegin),
        ("device-list", None) => Ok(PluginIn::DeviceList),
        ("shutdown", None) => Ok(PluginIn::Shutdown),
        ("device-forget", Some(id)) => {
            let parsed: EndpointId = id.parse().context("invalid device id")?;
            if parsed.to_string() != id {
                bail!("device id is not canonical");
            }
            Ok(PluginIn::DeviceForget { id })
        }
        _ => bail!("unsupported stdio fields or command"),
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum PluginOut {
    Ready {
        endpoint_id: String,
        direct_addresses: Vec<String>,
        local_only: bool,
    },
    Pairing {
        code: String,
        expires_in_sec: u64,
    },
    PairingClosed {
        reason: String,
    },
    PairingDone {
        peer: String,
        name: String,
    },
    PeerConnected {
        peer: String,
        name: String,
    },
    PeerPath {
        peer: String,
        kind: String,
        remote: String,
    },
    PeerDisconnected {
        peer: String,
    },
    ProxyOpened {
        peer: String,
    },
    Devices {
        devices: Vec<DeviceView>,
    },
    Error {
        code: String,
        message: String,
    },
    Stopped,
    ProxyReady {
        origin: String,
    },
}

fn emit(event: &PluginOut) {
    let mut value = serde_json::to_value(event).expect("event is serializable");
    value
        .as_object_mut()
        .expect("event is an object")
        .insert("version".into(), STDIO_VERSION.into());
    println!("{}", value);
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairedStore {
    devices: Vec<PairedDevice>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairedDevice {
    id: String,
    name: String,
    paired_at: String,
}

#[derive(Serialize)]
struct DeviceView {
    id: String,
    name: String,
    paired_at: String,
    online: bool,
}

struct PairingWindow {
    code: String,
    deadline: tokio::time::Instant,
    attempts: u32,
}

struct PeerConn {
    generation: u64,
    conn: Connection,
}

struct HostState {
    store_path: PathBuf,
    store: PairedStore,
    pairing: Option<PairingWindow>,
    conns: HashMap<String, PeerConn>,
    next_generation: u64,
    shutdown: watch::Sender<bool>,
}

/// Closing an owning handler always terminates its transport and child streams.
struct CloseConnection(Connection);
impl Drop for CloseConnection {
    fn drop(&mut self) {
        self.0.close(0u8.into(), b"control closed");
    }
}

fn default_data_dir(name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        dirs::home_dir()
            .expect("Windows user profile must be available")
            .join(format!(".{name}"))
    }
    #[cfg(not(windows))]
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(name)
}

/// An OS-owned profile lock prevents concurrent identity/authorization updates.
fn lock_data_dir(dir: &Path) -> Result<std::fs::File> {
    create_private_directory(dir)?;
    if std::fs::symlink_metadata(dir)?.file_type().is_symlink() {
        bail!("data directory must not be a symbolic link");
    }
    let path = dir.join("host.lock");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("profile lock must not be a symbolic link");
    }
    let file = open_private_lock_file(&path).context("cannot open profile lock")?;
    file.try_lock()
        .context("another host owns this data directory")?;
    Ok(file)
}

fn check_loopback(address: SocketAddr, allow_zero: bool) -> Result<SocketAddr> {
    if !address.ip().is_loopback() || (!allow_zero && address.port() == 0) {
        bail!("address must be an explicit non-wildcard loopback socket");
    }
    Ok(address)
}

fn load_store(path: &Path) -> Result<PairedStore> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(PairedStore::default()),
        Err(error) => return Err(error).context("cannot inspect paired-device state"),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_STORE_BYTES as u64
    {
        bail!("paired-device state is not a bounded regular file");
    }
    let store: PairedStore = serde_json::from_slice(
        &read_private_file(path, MAX_STORE_BYTES).context("cannot read paired-device state")?,
    )
    .context("paired-device state is invalid")?;
    if store.devices.len() > MAX_DEVICES {
        bail!("paired-device state exceeds device limit");
    }
    let mut seen = HashSet::new();
    for device in &store.devices {
        let parsed: EndpointId = device.id.parse().context("invalid stored peer id")?;
        if parsed.to_string() != device.id || !seen.insert(&device.id) {
            bail!("stored peer id is duplicate or not canonical");
        }
        validate_device_name(&device.name)?;
        if !device.paired_at.starts_with("unix:")
            || device.paired_at.len() > 32
            || device.paired_at[5..].parse::<u64>().is_err()
        {
            bail!("invalid pairing timestamp");
        }
    }
    Ok(store)
}

fn save_store(path: &Path, store: &PairedStore) -> Result<()> {
    write_private(path, &serde_json::to_vec_pretty(store)?)
}

fn begin_pairing(state: &mut HostState) {
    let code = format!("{:06}", rand::rng().random_range(0..1_000_000u32));
    emit(&PluginOut::Pairing {
        code: code.clone(),
        expires_in_sec: PAIRING_TTL.as_secs(),
    });
    state.pairing = Some(PairingWindow {
        code,
        deadline: tokio::time::Instant::now() + PAIRING_TTL,
        attempts: 0,
    });
}

fn device_views(state: &HostState) -> Vec<DeviceView> {
    state
        .store
        .devices
        .iter()
        .map(|d| DeviceView {
            id: d.id.clone(),
            name: d.name.clone(),
            paired_at: d.paired_at.clone(),
            online: state.conns.contains_key(&d.id),
        })
        .collect()
}

async fn make_endpoint(secret: iroh::SecretKey, local_only: bool) -> Result<Endpoint> {
    let builder = if local_only {
        Endpoint::builder(presets::Minimal)
            .clear_ip_transports()
            .bind_addr(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))?
    } else {
        Endpoint::builder(presets::N0)
    };
    Ok(builder
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?)
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    dsh_mobile_iroh_core::i18n::set_from_tag(&cli.lang);
    let tls_force = matches!(&cli.command, Command::TlsRenew { .. });
    match cli.command {
        Command::TlsPrepare {
            data_dir,
            leaf_validity_days,
            renew_before_days,
            hold,
            lease_timeout_ms,
        }
        | Command::TlsRenew {
            data_dir,
            leaf_validity_days,
            renew_before_days,
            hold,
            lease_timeout_ms,
        } => {
            let policy = tls::Policy {
                leaf_validity_days,
                renew_before_days,
            };
            let (state, lease) = if hold {
                tls::prepare_held(&data_dir, policy, tls_force)
                    .map(|(state, lease)| (state, Some(lease)))
            } else {
                tls::prepare(&data_dir, policy, tls_force).map(|state| (state, None))
            }
            .map_err(|_| anyhow::anyhow!("host TLS preparation failed"))?;
            println!("{}", serde_json::to_string(&state)?);
            if hold {
                std::io::Write::flush(&mut std::io::stdout())?;
                wait_tls_release(Duration::from_millis(lease_timeout_ms))
                    .await
                    .map_err(|_| anyhow::anyhow!("host TLS lease release failed"))?;
            }
            drop(lease);
        }
        Command::TlsStatus { data_dir } => {
            let state =
                tls::status(&data_dir).map_err(|_| anyhow::anyhow!("host TLS status failed"))?;
            println!("{}", serde_json::to_string(&state)?);
        }
        Command::OperatorConfigLoad { data_dir } => {
            let state = operator_config::load(&data_dir)
                .map_err(|_| anyhow::anyhow!("host operator configuration load failed"))?;
            println!("{}", serde_json::to_string(&state)?);
        }
        Command::OperatorConfigSave {
            data_dir,
            upstream_origin,
            local_port,
            local_only,
        } => {
            let state = operator_config::save(&data_dir, &upstream_origin, local_port, local_only)
                .map_err(|_| anyhow::anyhow!("host operator configuration save failed"))?;
            println!("{}", serde_json::to_string(&state)?);
        }
        Command::PreferenceLoad { data_dir } => {
            let state = preferences::load(&data_dir)
                .map_err(|_| anyhow::anyhow!("host preference load failed"))?;
            println!("{}", serde_json::to_string(&state)?);
        }
        Command::PreferenceSave { data_dir, enabled } => {
            let state = preferences::save(&data_dir, enabled)
                .map_err(|_| anyhow::anyhow!("host preference save failed"))?;
            println!("{}", serde_json::to_string(&state)?);
        }
        Command::Id { data_dir } => {
            let dir = data_dir.unwrap_or_else(|| default_data_dir("dsh-mobile-iroh"));
            println!(
                "{}",
                tls::load_identity(&dir)
                    .map_err(|_| anyhow::anyhow!("host identity unavailable"))?
                    .public()
            );
        }
        Command::Host {
            data_dir,
            pair,
            proxy_target,
            local_only,
        } => {
            host_main(
                data_dir.unwrap_or_else(|| default_data_dir("dsh-mobile-iroh")),
                pair,
                proxy_target,
                local_only,
            )
            .await?
        }
        Command::PhoneSim {
            data_dir,
            peer,
            peer_address,
            code,
            name,
            proxy_listen,
            local_only,
        } => {
            phone_sim_main(
                data_dir.unwrap_or_else(|| default_data_dir("dsh-mobile-iroh-phone-sim")),
                peer,
                peer_address,
                code,
                name,
                proxy_listen,
                local_only,
            )
            .await?
        }
    }
    Ok(())
}

async fn host_main(
    data_dir: PathBuf,
    pair: bool,
    proxy_target: Option<SocketAddr>,
    local_only: bool,
) -> Result<()> {
    let proxy_target = proxy_target
        .map(|target| check_loopback(target, false))
        .transpose()?;
    let _lease = lock_data_dir(&data_dir)?;
    let store_path = data_dir.join("paired.json");
    let store = load_store(&store_path)?;
    let secret =
        tls::load_identity(&data_dir).map_err(|_| anyhow::anyhow!("host identity unavailable"))?;
    let endpoint = make_endpoint(secret, local_only).await?;
    let (shutdown, mut shutdown_rx) = watch::channel(false);
    let mut state = HostState {
        store_path,
        store,
        pairing: None,
        conns: HashMap::new(),
        next_generation: 0,
        shutdown,
    };
    emit(&PluginOut::Ready {
        endpoint_id: endpoint.id().to_string(),
        direct_addresses: endpoint
            .addr()
            .ip_addrs()
            .map(ToString::to_string)
            .collect(),
        local_only,
    });
    if pair || state.store.devices.is_empty() {
        begin_pairing(&mut state);
    }
    let state = Arc::new(Mutex::new(state));
    let mut stdin = Box::pin(stdin_loop(tokio::io::stdin(), state.clone()));
    let mut handlers = JoinSet::new();
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let streams = Arc::new(Semaphore::new(MAX_GLOBAL_PROXY_STREAMS));
    let failure = loop {
        tokio::select! {
            result = &mut stdin => break result.err(),
            _ = tokio::signal::ctrl_c() => break None,
            _ = shutdown_rx.changed() => break Some(anyhow::anyhow!("authorization persistence failed")),
            result = handlers.join_next(), if !handlers.is_empty() => {
                if let Some(Err(error)) = result { eprintln!("host connection task failed: {error}"); }
            }
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break None; };
                let Ok(permit) = connections.clone().try_acquire_owned() else { incoming.refuse(); continue; };
                let state = state.clone();
                let streams = streams.clone();
                handlers.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = handle_phone(incoming, state, proxy_target, streams).await { eprintln!("inbound transport rejected: {error}"); }
                });
            }
        }
    };
    {
        let mut state = state.lock().await;
        state.pairing = None;
        for (_, peer) in state.conns.drain() {
            peer.conn.close(0u8.into(), b"host stopped");
        }
    }
    endpoint.close().await;
    handlers.abort_all();
    while handlers.join_next().await.is_some() {}
    emit(&PluginOut::Stopped);
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}

async fn stdin_loop<R: AsyncRead + Unpin>(
    mut input: R,
    state: Arc<Mutex<HostState>>,
) -> Result<()> {
    loop {
        // Keep no more than one bounded line; EOF at a line boundary is normal shutdown.
        let mut first = [0u8; 1];
        if input.read(&mut first).await? == 0 {
            return Ok(());
        }
        let mut prefixed = tokio::io::AsyncReadExt::chain(&first[..], &mut input);
        let line = read_line_bounded(&mut prefixed, MAX_STDIN_LINE).await?;
        let command = match decode_command(&line) {
            Ok(command) => command,
            Err(_) => {
                emit(&PluginOut::Error {
                    code: "invalid-command".into(),
                    message: "Invalid or unsupported sidecar command".into(),
                });
                return Err(anyhow::anyhow!("invalid sidecar command"));
            }
        };
        let mut state = state.lock().await;
        match command {
            PluginIn::Shutdown => return Ok(()),
            PluginIn::PairingBegin => begin_pairing(&mut state),
            PluginIn::DeviceList => emit(&PluginOut::Devices {
                devices: device_views(&state),
            }),
            PluginIn::DeviceForget { id } => {
                let mut next = state.store.clone();
                next.devices.retain(|device| device.id != id);
                save_store(&state.store_path, &next).context("cannot persist device revocation")?;
                state.store = next;
                if let Some(peer) = state.conns.remove(&id) {
                    peer.conn.close(1u8.into(), b"revoked");
                }
                emit(&PluginOut::Devices {
                    devices: device_views(&state),
                });
            }
        }
    }
}

async fn handle_phone(
    incoming: iroh::endpoint::Incoming,
    state: Arc<Mutex<HostState>>,
    target: Option<SocketAddr>,
    global_streams: Arc<Semaphore>,
) -> Result<()> {
    let conn = timeout(HANDSHAKE_BUDGET, incoming)
        .await
        .context("TLS handshake timed out")??;
    let _close = CloseConnection(conn.clone());
    let remote = conn.remote_id().to_string();
    let authorized = authorize(&conn, &remote, state.clone()).await?;
    let generation = authorized.generation;
    let result = serve_peer(&conn, &remote, authorized.control, target, global_streams).await;
    let mut state = state.lock().await;
    if state
        .conns
        .get(&remote)
        .is_some_and(|peer| peer.generation == generation)
    {
        state.conns.remove(&remote);
        emit(&PluginOut::PeerDisconnected { peer: remote });
    }
    result
}

struct AuthorizedPeer {
    generation: u64,
    control: (iroh::endpoint::SendStream, iroh::endpoint::RecvStream),
}

async fn authorize(
    conn: &Connection,
    remote: &str,
    state: Arc<Mutex<HostState>>,
) -> Result<AuthorizedPeer> {
    let (mut send, mut recv) = timeout(HANDSHAKE_BUDGET, conn.accept_bi())
        .await
        .context("control stream timed out")??;
    let first = timeout(
        HANDSHAKE_BUDGET,
        read_line_bounded(&mut recv, MAX_UNPAIRED_LINE),
    )
    .await
    .context("control handshake timed out")??;
    let message = decode_wire(&first)?;
    let mut state = state.lock().await;
    let paired = state.store.devices.iter().any(|device| device.id == remote);
    let (name, ack) = match (paired, message) {
        (true, Wire::Hello { name }) => (name, Wire::HelloOk),
        (_, Wire::Pair { code, name }) => {
            let verdict = match state.pairing.as_mut() {
                None => Err(PAIR_NO_WINDOW),
                Some(window) if window.deadline <= tokio::time::Instant::now() => Err(PAIR_EXPIRED),
                Some(window) if window.attempts >= PAIRING_MAX_ATTEMPTS => {
                    Err(PAIR_TOO_MANY_ATTEMPTS)
                }
                Some(window) => {
                    window.attempts += 1;
                    if window.code == code {
                        Ok(())
                    } else if window.attempts >= PAIRING_MAX_ATTEMPTS {
                        Err(PAIR_TOO_MANY_ATTEMPTS)
                    } else {
                        Err(PAIR_BAD_CODE)
                    }
                }
            };
            if let Err(reason) = verdict {
                if state.pairing.as_ref().is_some_and(|w| {
                    w.attempts >= PAIRING_MAX_ATTEMPTS || w.deadline <= tokio::time::Instant::now()
                }) {
                    state.pairing = None;
                    emit(&PluginOut::PairingClosed {
                        reason: reason.into(),
                    });
                }
                drop(state);
                timeout(
                    PROXY_OPEN_BUDGET,
                    write_line(
                        &mut send,
                        &encode_wire(&Wire::PairFail {
                            reason: reason.into(),
                        })?,
                    ),
                )
                .await??;
                send.finish()?;
                let _ = timeout(Duration::from_secs(1), send.stopped()).await;
                bail!("pairing rejected");
            }
            if !paired && state.store.devices.len() >= MAX_DEVICES {
                bail!("paired-device limit reached");
            }
            let mut next = state.store.clone();
            if let Some(device) = next.devices.iter_mut().find(|device| device.id == remote) {
                device.name = name.clone();
            } else {
                next.devices.push(PairedDevice {
                    id: remote.into(),
                    name: name.clone(),
                    paired_at: chrono_now(),
                });
            }
            if let Err(error) = save_store(&state.store_path, &next) {
                let _ = state.shutdown.send(true);
                return Err(error).context("cannot persist new peer");
            }
            state.store = next;
            state.pairing = None;
            emit(&PluginOut::PairingDone {
                peer: remote.into(),
                name: name.clone(),
            });
            (name, Wire::PairOk)
        }
        _ => bail!("unauthorized or invalid control handshake"),
    };
    // Keep authorization and registration indivisible with respect to revocation.
    // The peer write is bounded and only contains a small handshake ACK.
    timeout(
        PROXY_OPEN_BUDGET,
        write_line(&mut send, &encode_wire(&ack)?),
    )
    .await??;
    state.next_generation = state
        .next_generation
        .checked_add(1)
        .context("connection generation exhausted")?;
    let generation = state.next_generation;
    if let Some(previous) = state.conns.insert(
        remote.into(),
        PeerConn {
            generation,
            conn: conn.clone(),
        },
    ) {
        previous.conn.close(1u8.into(), b"replaced");
    }
    drop(state);
    emit(&PluginOut::PeerConnected {
        peer: remote.into(),
        name,
    });
    Ok(AuthorizedPeer {
        generation,
        control: (send, recv),
    })
}

async fn serve_peer(
    conn: &Connection,
    remote: &str,
    control_stream: (iroh::endpoint::SendStream, iroh::endpoint::RecvStream),
    target: Option<SocketAddr>,
    global_streams: Arc<Semaphore>,
) -> Result<()> {
    let (_send, mut recv) = control_stream;
    let mut streams = JoinSet::new();
    let local_streams = Arc::new(Semaphore::new(MAX_PROXY_STREAMS));
    let mut path_tick = tokio::time::interval(Duration::from_millis(500));
    let mut reported_path = None;
    let mut proxy_announced = false;
    let control = read_line_bounded(&mut recv, MAX_UNPAIRED_LINE);
    tokio::pin!(control);
    let result = loop {
        tokio::select! {
            result = &mut control => break result.and_then(|line| { decode_wire(&line)?; bail!("unexpected post-handshake control message") }),
            _ = conn.closed() => break Ok(()),
            _ = path_tick.tick() => {
                let selected = conn.paths().iter().find(|p| p.is_selected()).map(|p| {
                    let address = p.remote_addr();
                    (if address.is_ip() { "direct" } else { "relay" }.to_string(), format!("{address:?}"))
                });
                if selected != reported_path {
                    if let Some((kind, address)) = &selected { emit(&PluginOut::PeerPath { peer: remote.into(), kind: kind.clone(), remote: address.clone() }); }
                    reported_path = selected;
                }
            }
            _ = streams.join_next(), if !streams.is_empty() => {},
            incoming = conn.accept_bi() => {
                let (mut send, mut recv) = match incoming { Ok(value) => value, Err(_) => break Ok(()) };
                let (Some(target), Ok(local), Ok(global)) = (target, local_streams.clone().try_acquire_owned(), global_streams.clone().try_acquire_owned()) else {
                    let _ = send.reset(2u8.into()); let _ = recv.stop(2u8.into()); continue;
                };
                let conn = conn.clone();
                if !proxy_announced { emit(&PluginOut::ProxyOpened { peer: remote.into() }); proxy_announced = true; }
                streams.spawn(async move {
                    let (_local, _global) = (local, global);
                    let result = async {
                        let line = timeout(PROXY_OPEN_BUDGET, read_line_bounded(&mut recv, 128)).await??;
                        if decode_wire(&line)? != Wire::Proxy { bail!("proxy stream discriminator required"); }
                        let mut tcp = timeout(PROXY_OPEN_BUDGET, tokio::net::TcpStream::connect(target)).await??;
                        let mut stream = tokio::io::join(recv, send);
                        tokio::select! { result = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => { result?; }, _ = conn.closed() => {} }
                        Ok::<(), anyhow::Error>(())
                    }.await;
                    if let Err(error) = result { eprintln!("proxy stream rejected: {error}"); }
                });
            }
        }
    };
    conn.close(0u8.into(), b"control closed");
    streams.abort_all();
    while streams.join_next().await.is_some() {}
    result
}

fn chrono_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{seconds}")
}

/// One-line summary of what peer discovery knew when a dial failed.
///
/// `remote_info` is this endpoint's current view: no entry (or no addresses)
/// means the lookup found nothing to dial, while relay vs direct entries
/// distinguish the rendezvous path that was available. Snapshot only;
/// discovery keeps running in the background.
async fn describe_remote_route(endpoint: &Endpoint, peer: EndpointId) -> String {
    let mut relays = 0u32;
    let mut direct = 0u32;
    let mut other = 0u32;
    if let Some(info) = endpoint.remote_info(peer).await {
        for entry in info.addrs() {
            match entry.addr() {
                TransportAddr::Relay(_) => relays += 1,
                TransportAddr::Ip(_) => direct += 1,
                _ => other += 1,
            }
        }
    }
    if relays == 0 && direct == 0 && other == 0 {
        return "discovery found no addresses".to_string();
    }
    format!("discovery knew {relays} relay, {direct} direct, {other} other address(es)")
}

async fn phone_sim_main(
    data_dir: PathBuf,
    peer: EndpointId,
    addresses: Vec<SocketAddr>,
    code: Option<String>,
    name: String,
    listen: Option<SocketAddr>,
    local_only: bool,
) -> Result<()> {
    validate_device_name(&name)?;
    let listen = listen
        .map(|address| check_loopback(address, true))
        .transpose()?;
    if local_only
        && (addresses.is_empty()
            || addresses
                .iter()
                .any(|address| check_loopback(*address, false).is_err()))
    {
        bail!("local-only phone requires explicit loopback peer addresses");
    }
    let endpoint = make_endpoint(
        tls::load_identity(&data_dir).map_err(|_| anyhow::anyhow!("host identity unavailable"))?,
        local_only,
    )
    .await?;
    let address = addresses
        .into_iter()
        .fold(EndpointAddr::new(peer), |addr, ip| addr.with_ip_addr(ip));
    let result = async {
        let conn = match timeout(CONNECT_BUDGET, endpoint.connect(address, ALPN)).await {
            Ok(Ok(conn)) => conn,
            // Keep the established failure marker first; the route summary tells
            // a bare "timed out" apart from "resolved but unreachable".
            Ok(Err(error)) => {
                let route = describe_remote_route(&endpoint, peer).await;
                anyhow::bail!("host connection timed out ({route}): {error:#}")
            }
            Err(_) => {
                let route = describe_remote_route(&endpoint, peer).await;
                anyhow::bail!("host connection timed out ({route})")
            }
        };
        let _close = CloseConnection(conn.clone());
        let (mut send, mut recv) = timeout(HANDSHAKE_BUDGET, conn.open_bi()).await??;
        let first = match code { Some(code) => Wire::Pair { code, name }, None => Wire::Hello { name } };
        let pairing = matches!(first, Wire::Pair { .. });
        timeout(HANDSHAKE_BUDGET, write_line(&mut send, &encode_wire(&first)?)).await??;
        let response = timeout(HANDSHAKE_BUDGET, read_line_bounded(&mut recv, MAX_UNPAIRED_LINE)).await??;
        match (pairing, decode_wire(&response)?) {
            (true, Wire::PairOk) => eprintln!("paired"),
            (false, Wire::HelloOk) => eprintln!("authenticated"),
            (_, Wire::PairFail { reason }) => bail!("{}", pair_fail_text(&reason)),
            _ => bail!("host did not acknowledge control handshake"),
        }
        let listener = match listen { Some(address) => Some(tokio::net::TcpListener::bind(address).await?), None => None };
        if let Some(listener) = &listener { emit(&PluginOut::ProxyReady { origin: format!("http://{}", listener.local_addr()?) }); }
        let mut proxies = JoinSet::new();
        let slots = Arc::new(Semaphore::new(MAX_PROXY_STREAMS));
        let control = read_line_bounded(&mut recv, MAX_UNPAIRED_LINE);
        tokio::pin!(control);
        let outcome = loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => break Ok(()),
                _ = conn.closed() => break Ok(()),
                _ = &mut control => break Ok(()),
                _ = proxies.join_next(), if !proxies.is_empty() => {},
                incoming = async { match &listener { Some(listener) => listener.accept().await, None => std::future::pending().await } } => {
                    let (mut tcp, _) = incoming?;
                    let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                    let conn = conn.clone();
                    proxies.spawn(async move {
                        let _slot = slot;
                        let result = async {
                            let (mut send, recv) = timeout(PROXY_OPEN_BUDGET, conn.open_bi()).await??;
                            timeout(PROXY_OPEN_BUDGET, write_line(&mut send, &encode_wire(&Wire::Proxy)?)).await??;
                            let mut stream = tokio::io::join(recv, send);
                            tokio::select! { result = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => { result?; }, _ = conn.closed() => {} }
                            Ok::<(), anyhow::Error>(())
                        }.await;
                        if let Err(error) = result { eprintln!("local proxy failed: {error:#}"); }
                    });
                }
            }
        };
        conn.close(0u8.into(), b"phone stopped");
        proxies.abort_all();
        while proxies.join_next().await.is_some() {}
        outcome
    }.await;
    endpoint.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt as _;

    fn test_root(label: &str) -> PathBuf {
        #[cfg(windows)]
        let parent = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
        #[cfg(not(windows))]
        let parent = std::env::temp_dir();
        let root = parent.join(format!(".iroh-host-{}-{label}", std::process::id()));
        create_private_directory(&root).unwrap();
        root
    }

    struct TestHost {
        endpoint: Endpoint,
        state: Arc<Mutex<HostState>>,
        acceptor: tokio::task::JoinHandle<()>,
        root: PathBuf,
    }

    impl TestHost {
        async fn start(target: Option<SocketAddr>) -> Self {
            let key = iroh::SecretKey::generate();
            let root = test_root(&key.public().to_string());
            let endpoint = make_endpoint(key, true).await.unwrap();
            let (shutdown, _) = watch::channel(false);
            let state = Arc::new(Mutex::new(HostState {
                store_path: root.join("paired.json"),
                store: PairedStore::default(),
                pairing: Some(PairingWindow {
                    code: "123456".into(),
                    deadline: tokio::time::Instant::now() + PAIRING_TTL,
                    attempts: 0,
                }),
                conns: HashMap::new(),
                next_generation: 0,
                shutdown,
            }));
            let server = endpoint.clone();
            let shared = state.clone();
            let acceptor = tokio::spawn(async move {
                let mut handlers = JoinSet::new();
                let streams = Arc::new(Semaphore::new(MAX_GLOBAL_PROXY_STREAMS));
                loop {
                    tokio::select! {
                        incoming = server.accept() => {
                            let Some(incoming) = incoming else { break; };
                            let state = shared.clone(); let streams = streams.clone();
                            handlers.spawn(async move { let _ = handle_phone(incoming, state, target, streams).await; });
                        }
                        _ = handlers.join_next(), if !handlers.is_empty() => {},
                    }
                }
                handlers.abort_all();
                while handlers.join_next().await.is_some() {}
            });
            Self {
                endpoint,
                state,
                acceptor,
                root,
            }
        }

        async fn client(
            &self,
            key: iroh::SecretKey,
            message: &str,
        ) -> (
            Endpoint,
            Connection,
            iroh::endpoint::SendStream,
            iroh::endpoint::RecvStream,
        ) {
            let endpoint = make_endpoint(key, true).await.unwrap();
            let conn = timeout(
                Duration::from_secs(5),
                endpoint.connect(self.endpoint.addr(), ALPN),
            )
            .await
            .unwrap()
            .unwrap();
            let (mut send, recv) = conn.open_bi().await.unwrap();
            write_line(&mut send, message).await.unwrap();
            (endpoint, conn, send, recv)
        }

        async fn pair(
            &self,
            key: iroh::SecretKey,
        ) -> (
            Endpoint,
            Connection,
            iroh::endpoint::SendStream,
            iroh::endpoint::RecvStream,
        ) {
            let message = encode_wire(&Wire::Pair {
                code: "123456".into(),
                name: "test phone".into(),
            })
            .unwrap();
            let (endpoint, conn, send, mut recv) = self.client(key, &message).await;
            let reply = timeout(Duration::from_secs(5), read_line_bounded(&mut recv, 512))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(decode_wire(&reply).unwrap(), Wire::PairOk);
            (endpoint, conn, send, recv)
        }

        async fn close(self) {
            self.endpoint.close().await;
            timeout(Duration::from_secs(5), self.acceptor)
                .await
                .unwrap()
                .unwrap();
            std::fs::remove_dir_all(self.root).unwrap();
        }
    }

    async fn wait_until_empty(state: &Arc<Mutex<HostState>>) {
        timeout(Duration::from_secs(5), async {
            loop {
                if state.lock().await.conns.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn open_proxy(
        conn: &Connection,
    ) -> (iroh::endpoint::SendStream, iroh::endpoint::RecvStream) {
        let (mut send, recv) = conn.open_bi().await.unwrap();
        write_line(&mut send, &encode_wire(&Wire::Proxy).unwrap())
            .await
            .unwrap();
        (send, recv)
    }

    #[tokio::test]
    async fn real_quic_rejects_unversioned_unknown_and_unpaired_hello() {
        let host = TestHost::start(None).await;
        for message in [
            r#"{"type":"pair","code":"123456","name":"phone"}"#,
            r#"{"version":2,"type":"pair","code":"123456","name":"phone"}"#,
            r#"{"version":1,"type":"pair","code":"123456","name":"phone","unknown":true}"#,
            r#"{"version":1,"type":"hello","name":"phone"}"#,
        ] {
            let (endpoint, conn, _send, mut recv) =
                host.client(iroh::SecretKey::generate(), message).await;
            assert!(
                timeout(Duration::from_secs(5), read_line_bounded(&mut recv, 512))
                    .await
                    .unwrap()
                    .is_err()
            );
            timeout(Duration::from_secs(5), conn.closed())
                .await
                .unwrap();
            endpoint.close().await;
            assert!(host.state.lock().await.store.devices.is_empty());
        }
        host.close().await;
    }

    #[tokio::test]
    async fn dial_failure_reports_discovered_route() {
        let host = TestHost::start(None).await;
        // Unknown peer: nothing dialed yet, so the lookup found nothing.
        let dialer = make_endpoint(iroh::SecretKey::generate(), true)
            .await
            .unwrap();
        assert_eq!(
            describe_remote_route(&dialer, host.endpoint.id()).await,
            "discovery found no addresses"
        );
        // Explicitly dialed peer: discovery knows the direct address.
        let _conn = timeout(
            Duration::from_secs(10),
            dialer.connect(host.endpoint.addr(), ALPN),
        )
        .await
        .unwrap()
        .unwrap();
        let summary = describe_remote_route(&dialer, host.endpoint.id()).await;
        assert!(
            summary.contains("1 direct"),
            "unexpected route summary: {summary}"
        );
        dialer.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn real_quic_pair_persist_reconnect_replace_and_control_eof() {
        let host = TestHost::start(None).await;
        let key = iroh::SecretKey::generate();
        let id = key.public().to_string();
        let (first_ep, first, _send, _recv) = host.pair(key.clone()).await;
        assert_eq!(
            load_store(&host.state.lock().await.store_path)
                .unwrap()
                .devices
                .len(),
            1
        );
        let hello = encode_wire(&Wire::Hello {
            name: "same phone".into(),
        })
        .unwrap();
        let (next_ep, next, mut send, mut recv) = host.client(key, &hello).await;
        assert_eq!(
            decode_wire(&read_line_bounded(&mut recv, 512).await.unwrap()).unwrap(),
            Wire::HelloOk
        );
        timeout(Duration::from_secs(5), first.closed())
            .await
            .unwrap();
        let generation = host.state.lock().await.conns.get(&id).unwrap().generation;
        assert_eq!(generation, 2);
        first_ep.close().await;
        assert_eq!(
            host.state.lock().await.conns.get(&id).unwrap().generation,
            generation
        );
        send.finish().unwrap();
        timeout(Duration::from_secs(5), next.closed())
            .await
            .unwrap();
        wait_until_empty(&host.state).await;
        next_ep.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn real_quic_forwards_http_websocket_and_binary_without_rewrite() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = listener.local_addr().unwrap();
        let backend = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                tcp.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            assert_eq!(request, b"GET /private HTTP/1.1\r\nHost: secure.iroh.localhost\r\nCookie: device=phone\r\nOrigin: https://secure.iroh.localhost\r\n\r\n");
            tcp.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nConnection: close\r\n\r\nbody").await.unwrap();
            drop(tcp);
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                tcp.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            assert!(request.windows(18).any(|s| s == b"Upgrade: websocket"));
            tcp.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
            let mut frame = [0u8; 8];
            tcp.read_exact(&mut frame).await.unwrap();
            assert_eq!(frame, [0x81, 0x82, 1, 2, 3, 4, b'h' ^ 1, b'i' ^ 2]);
            tcp.write_all(&[0x81, 2, b'h', b'i']).await.unwrap();
            drop(tcp);
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut bytes = [0u8; 6];
            tcp.read_exact(&mut bytes).await.unwrap();
            assert_eq!(bytes, [0x16, 0x03, 0x03, 0, 1, 0xff]);
            tcp.write_all(&bytes).await.unwrap();
        });
        let host = TestHost::start(Some(target)).await;
        let (ep, conn, _control_send, _control_recv) = host.pair(iroh::SecretKey::generate()).await;
        let (mut send, mut recv) = open_proxy(&conn).await;
        send.write_all(b"GET /private HTTP/1.1\r\nHost: secure.iroh.localhost\r\nCookie: device=phone\r\nOrigin: https://secure.iroh.localhost\r\n\r\n").await.unwrap();
        send.finish().unwrap();
        let response = timeout(Duration::from_secs(5), recv.read_to_end(4096))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response, b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nConnection: close\r\n\r\nbody");
        let (mut send, mut recv) = open_proxy(&conn).await;
        send.write_all(b"GET /ws HTTP/1.1\r\nHost: secure.iroh.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
        let expected = b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
        let mut head = vec![0u8; expected.len()];
        recv.read_exact(&mut head).await.unwrap();
        assert_eq!(head, expected);
        send.write_all(&[0x81, 0x82, 1, 2, 3, 4, b'h' ^ 1, b'i' ^ 2])
            .await
            .unwrap();
        let mut frame = [0u8; 4];
        recv.read_exact(&mut frame).await.unwrap();
        assert_eq!(frame, [0x81, 2, b'h', b'i']);
        let (mut send, mut recv) = open_proxy(&conn).await;
        send.write_all(&[0x16, 0x03, 0x03, 0, 1, 0xff])
            .await
            .unwrap();
        let mut bytes = [0u8; 6];
        recv.read_exact(&mut bytes).await.unwrap();
        assert_eq!(bytes, [0x16, 0x03, 0x03, 0, 1, 0xff]);
        timeout(Duration::from_secs(5), backend)
            .await
            .unwrap()
            .unwrap();
        ep.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn real_quic_revocation_closes_proxy_and_survives_reload() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = listener.local_addr().unwrap();
        let host = TestHost::start(Some(target)).await;
        let key = iroh::SecretKey::generate();
        let peer = key.public().to_string();
        let (ep, conn, _control_send, _control_recv) = host.pair(key.clone()).await;
        let (mut send, mut recv) = open_proxy(&conn).await;
        send.write_all(b"alive").await.unwrap();
        let (mut backend, _) = timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut bytes = [0; 5];
        backend.read_exact(&mut bytes).await.unwrap();
        let command = format!("{{\"version\":1,\"type\":\"device-forget\",\"id\":\"{peer}\"}}\n");
        stdin_loop(command.as_bytes(), host.state.clone())
            .await
            .unwrap();
        timeout(Duration::from_secs(5), conn.closed())
            .await
            .unwrap();
        assert!(
            timeout(Duration::from_secs(5), read_line_bounded(&mut recv, 128))
                .await
                .unwrap()
                .is_err()
        );
        assert_eq!(
            timeout(Duration::from_secs(5), backend.read(&mut bytes))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(load_store(&host.state.lock().await.store_path)
            .unwrap()
            .devices
            .is_empty());
        let hello = encode_wire(&Wire::Hello {
            name: "revoked phone".into(),
        })
        .unwrap();
        let (again, rejected, _send, _recv) = host.client(key, &hello).await;
        timeout(Duration::from_secs(5), rejected.closed())
            .await
            .unwrap();
        again.close().await;
        ep.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn failed_pair_persistence_never_acknowledges_or_changes_authorization() {
        let host = TestHost::start(None).await;
        host.state.lock().await.store_path = host.root.clone();
        let message = encode_wire(&Wire::Pair {
            code: "123456".into(),
            name: "phone".into(),
        })
        .unwrap();
        let (ep, conn, _send, mut recv) = host.client(iroh::SecretKey::generate(), &message).await;
        assert!(
            timeout(Duration::from_secs(5), read_line_bounded(&mut recv, 512))
                .await
                .unwrap()
                .is_err()
        );
        timeout(Duration::from_secs(5), conn.closed())
            .await
            .unwrap();
        let state = host.state.lock().await;
        assert!(state.store.devices.is_empty());
        assert!(state.conns.is_empty());
        drop(state);
        ep.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn wrong_pairing_codes_are_globally_limited_and_close_the_window() {
        let host = TestHost::start(None).await;
        for expected in [
            PAIR_BAD_CODE,
            PAIR_BAD_CODE,
            PAIR_TOO_MANY_ATTEMPTS,
            PAIR_NO_WINDOW,
        ] {
            let message = encode_wire(&Wire::Pair {
                code: "999999".into(),
                name: "phone".into(),
            })
            .unwrap();
            let (ep, conn, _send, mut recv) =
                host.client(iroh::SecretKey::generate(), &message).await;
            let response = timeout(Duration::from_secs(5), read_line_bounded(&mut recv, 512))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                decode_wire(&response).unwrap(),
                Wire::PairFail {
                    reason: expected.into()
                }
            );
            conn.close(0u8.into(), b"test completed");
            ep.close().await;
        }
        assert!(host.state.lock().await.pairing.is_none());
        assert!(host.state.lock().await.store.devices.is_empty());
        host.close().await;
    }

    #[tokio::test]
    async fn already_paired_peer_can_explicitly_repair_only_with_a_fresh_valid_window() {
        let host = TestHost::start(None).await;
        let key = iroh::SecretKey::generate();
        let (first_ep, first, _first_send, _first_recv) = host.pair(key.clone()).await;
        let old_timestamp = host.state.lock().await.store.devices[0].paired_at.clone();
        let pair = encode_wire(&Wire::Pair {
            code: "123456".into(),
            name: "phone".into(),
        })
        .unwrap();
        let (refused_ep, refused, _send, mut recv) = host.client(key.clone(), &pair).await;
        assert_eq!(
            decode_wire(&read_line_bounded(&mut recv, 512).await.unwrap()).unwrap(),
            Wire::PairFail {
                reason: PAIR_NO_WINDOW.into()
            }
        );
        refused.close(0u8.into(), b"test done");
        refused_ep.close().await;
        assert!(first.close_reason().is_none());
        host.state.lock().await.pairing = Some(PairingWindow {
            code: "123456".into(),
            deadline: tokio::time::Instant::now() + PAIRING_TTL,
            attempts: 0,
        });
        let (next_ep, next, mut next_send, _next_recv) = host.pair(key).await;
        timeout(Duration::from_secs(5), first.closed())
            .await
            .unwrap();
        let state = host.state.lock().await;
        assert_eq!(state.store.devices.len(), 1);
        assert_eq!(state.store.devices[0].paired_at, old_timestamp);
        drop(state);
        next_send.finish().unwrap();
        timeout(Duration::from_secs(5), next.closed())
            .await
            .unwrap();
        first_ep.close().await;
        next_ep.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn revoking_one_peer_keeps_other_authorized_sessions_alive() {
        let host = TestHost::start(None).await;
        let first_key = iroh::SecretKey::generate();
        let first_id = first_key.public().to_string();
        let (first_ep, first, _first_send, _first_recv) = host.pair(first_key).await;
        host.state.lock().await.pairing = Some(PairingWindow {
            code: "123456".into(),
            deadline: tokio::time::Instant::now() + PAIRING_TTL,
            attempts: 0,
        });
        let second_key = iroh::SecretKey::generate();
        let second_id = second_key.public().to_string();
        let (second_ep, second, mut second_send, _second_recv) = host.pair(second_key).await;
        let command =
            format!("{{\"version\":1,\"type\":\"device-forget\",\"id\":\"{first_id}\"}}\n");
        stdin_loop(command.as_bytes(), host.state.clone())
            .await
            .unwrap();
        timeout(Duration::from_secs(5), first.closed())
            .await
            .unwrap();
        assert!(second.close_reason().is_none());
        assert!(host.state.lock().await.conns.contains_key(&second_id));
        let store = load_store(&host.state.lock().await.store_path).unwrap();
        assert_eq!(store.devices.len(), 1);
        assert_eq!(store.devices[0].id, second_id);
        second_send.finish().unwrap();
        timeout(Duration::from_secs(5), second.closed())
            .await
            .unwrap();
        first_ep.close().await;
        second_ep.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn proxy_quota_and_open_deadline_release_resources() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = TestHost::start(Some(listener.local_addr().unwrap())).await;
        let (ep, conn, mut control_send, _control_recv) =
            host.pair(iroh::SecretKey::generate()).await;
        let mut stalled = Vec::new();
        for _ in 0..MAX_PROXY_STREAMS {
            let (mut send, recv) = conn.open_bi().await.unwrap();
            send.write_all(b"{").await.unwrap();
            stalled.push((send, recv));
        }
        // Ordered bi stream IDs ensure the 33rd proxy is rejected rather than
        // queued behind 32 peers that never complete their discriminator.
        let (mut excess_send, mut excess_recv) = conn.open_bi().await.unwrap();
        write_line(&mut excess_send, &encode_wire(&Wire::Proxy).unwrap())
            .await
            .unwrap();
        let mut byte = [0u8; 1];
        assert!(timeout(Duration::from_secs(3), excess_recv.read(&mut byte))
            .await
            .unwrap()
            .is_err());
        assert!(timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err());
        assert!(matches!(
            timeout(
                PROXY_OPEN_BUDGET + Duration::from_secs(2),
                stalled[0].1.read(&mut byte)
            )
            .await
            .unwrap(),
            Err(_) | Ok(None)
        ));
        control_send.finish().unwrap();
        timeout(Duration::from_secs(5), conn.closed())
            .await
            .unwrap();
        wait_until_empty(&host.state).await;
        ep.close().await;
        host.close().await;
    }

    #[test]
    fn profile_lock_rejects_concurrent_hosts_and_releases_on_drop() {
        let dir = test_root("lock");
        let first = lock_data_dir(&dir).unwrap();
        assert!(lock_data_dir(&dir).is_err());
        drop(first);
        drop(lock_data_dir(&dir).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn loopback_targets_are_strict() {
        for address in ["127.0.0.1:3443", "[::1]:3443"] {
            assert!(check_loopback(address.parse().unwrap(), false).is_ok());
        }
        for address in [
            "0.0.0.0:3443",
            "[::]:3443",
            "192.168.1.1:3443",
            "127.0.0.1:0",
        ] {
            assert!(check_loopback(address.parse().unwrap(), false).is_err());
        }
    }
    #[test]
    fn stdio_is_versioned_and_exact() {
        for line in [
            r#"{"version":1,"type":"shutdown"}"#,
            r#"{"version":1,"type":"device-list"}"#,
            r#"{"version":1,"type":"pairing-begin"}"#,
        ] {
            assert!(decode_command(line).is_ok());
        }
        for line in [
            r#"{"type":"shutdown"}"#,
            r#"{"version":2,"type":"shutdown"}"#,
            r#"{"version":1,"type":"shutdown","extra":1}"#,
            r#"{"version":1,"type":"shutdown","id":"x"}"#,
            r#"{"version":1,"type":"shutdown","id":null}"#,
            r#"{"version":1,"type":"proxy-auth","cookie":"private","authority":"x"}"#,
        ] {
            assert!(decode_command(line).is_err());
        }
    }
    #[test]
    fn broken_stores_are_not_first_install() {
        let dir = test_root("store");
        let path = dir.join("paired.json");
        assert!(load_store(&path).unwrap().devices.is_empty());
        std::fs::write(&path, b"broken").unwrap();
        assert!(load_store(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
        assert!(load_store(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn line_reader_bounds_bytes_preserves_payload_and_rejects_invalid_utf8() {
        let mut input = &b"1234\npayload"[..];
        assert_eq!(read_line_bounded(&mut input, 4).await.unwrap(), "1234");
        assert_eq!(input, b"payload");
        assert!(read_line_bounded(&mut &b"12345\n"[..], 4).await.is_err());
        assert!(read_line_bounded(&mut &b"\xff\n"[..], 4).await.is_err());
        assert!(read_line_bounded(&mut &b"unterminated"[..], 16)
            .await
            .is_err());
    }

    #[test]
    fn full_roster_fits_bounded_parent_event() {
        let devices: Vec<_> = (0..MAX_DEVICES)
            .map(|_| DeviceView {
                id: iroh::SecretKey::generate().public().to_string(),
                name: "🐳".repeat(64),
                paired_at: "unix:18446744073709551615".into(),
                online: true,
            })
            .collect();
        let mut event = serde_json::to_value(PluginOut::Devices { devices }).unwrap();
        event
            .as_object_mut()
            .unwrap()
            .insert("version".into(), 1.into());
        assert!(serde_json::to_vec(&event).unwrap().len() < MAX_STDIN_LINE);
    }
}
