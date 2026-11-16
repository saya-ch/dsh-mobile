package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

const protocolVersion = 1

// errCertificate marks a missing or unissuable public certificate, which is not an
// authorization problem and needs its own product message.
var errCertificate = errors.New("funnel certificate unavailable")

var (
	hostnamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	loginURLPattern = regexp.MustCompile(`https://login\.tailscale\.com/[A-Za-z0-9?&=_./%-]+`)
)

type configuration struct {
	stateDir string
	hostname string
}

type command struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Target  string `json:"target"`
}

type reporter struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func (r *reporter) emit(event map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	event["version"] = protocolVersion
	_ = r.encoder.Encode(event)
}

func (r *reporter) failure(code string) {
	r.emit(map[string]any{"type": "error", "code": code})
}

func (r *reporter) setupFailure(code, setupURL string) {
	event := map[string]any{"type": "error", "code": code}
	if setupURL != "" {
		event["url"] = setupURL
	}
	r.emit(event)
}

func (r *reporter) userLogf(format string, arguments ...any) {
	line := fmt.Sprintf(format, arguments...)
	if loginURL := loginURLPattern.FindString(line); loginURL != "" {
		r.emit(map[string]any{"type": "login", "url": loginURL})
	}
}

func parseConfiguration(arguments []string) (configuration, error) {
	set := flag.NewFlagSet("dsh-mobile-funnel", flag.ContinueOnError)
	set.SetOutput(io.Discard)
	stateDir := set.String("state-dir", "", "private tsnet state directory")
	hostname := set.String("hostname", "", "stable Tailscale hostname")
	if err := set.Parse(arguments); err != nil || set.NArg() != 0 {
		return configuration{}, errors.New("invalid arguments")
	}
	if *stateDir == "" || !hostnamePattern.MatchString(*hostname) {
		return configuration{}, errors.New("invalid arguments")
	}
	return configuration{stateDir: *stateDir, hostname: *hostname}, nil
}

func readCommands(ctx context.Context, input io.Reader) <-chan command {
	commands := make(chan command, 1)
	go func() {
		defer close(commands)
		stopClosing := func() bool { return false }
		if closer, ok := input.(io.Closer); ok {
			stopClosing = context.AfterFunc(ctx, func() { _ = closer.Close() })
		}
		defer stopClosing()
		decoder := json.NewDecoder(io.LimitReader(input, 64*1024))
		for {
			var next command
			if err := decoder.Decode(&next); err != nil {
				return
			}
			select {
			case commands <- next:
			case <-ctx.Done():
				return
			}
		}
	}()
	return commands
}

func loopbackTarget(raw string) (*url.URL, error) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "http" || target.User != nil || target.Path != "" || target.RawQuery != "" || target.Fragment != "" {
		return nil, errors.New("invalid target")
	}
	host, port, err := net.SplitHostPort(target.Host)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || port == "" {
		return nil, errors.New("invalid target")
	}
	return target, nil
}

func waitForTarget(ctx context.Context, commands <-chan command) (*url.URL, error) {
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case next, ok := <-commands:
			if !ok {
				return nil, errors.New("control channel closed")
			}
			if next.Version != protocolVersion || next.Type != "serve" {
				return nil, errors.New("invalid command")
			}
			return loopbackTarget(next.Target)
		}
	}
}

func publicOrigin(dnsName string) (string, error) {
	hostname := strings.TrimSuffix(strings.ToLower(dnsName), ".")
	if !strings.HasSuffix(hostname, ".ts.net") {
		return "", errors.New("tailnet DNS name is unavailable")
	}
	return "https://" + hostname, nil
}

func classifyFunnelFailure(err error) (code, setupURL string) {
	message := err.Error()
	switch {
	case strings.Contains(message, "https://tailscale.com/s/no-funnel"):
		return "funnel_permission_required", "https://tailscale.com/s/no-funnel"
	case strings.Contains(message, "https://tailscale.com/s/https"):
		return "funnel_https_required", "https://tailscale.com/s/https"
	default:
		return "funnel_start_failed", ""
	}
}

// The one certificate fetch made before reporting serving must tolerate a cold ACME
// issuance, which measured about 39 seconds on a slow public route. The default keeps
// generous headroom; an operator can widen it through the environment without a rebuild.
const (
	defaultCertificateTimeout = 180 * time.Second
	minCertificateTimeout     = 30 * time.Second
	maxCertificateTimeout     = 900 * time.Second
)

// resolveCertificateTimeout reads the operator override in seconds and clamps it, so a
// malformed or hostile value cannot disable the bound or make shutdown hang for hours.
func resolveCertificateTimeout(raw string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || seconds <= 0 {
		return defaultCertificateTimeout
	}
	limit := time.Duration(seconds) * time.Second
	if limit < minCertificateTimeout {
		return minCertificateTimeout
	}
	if limit > maxCertificateTimeout {
		return maxCertificateTimeout
	}
	return limit
}

// verifyCertificate fetches the public certificate before the listener is reported as
// serving. tsnet resolves it lazily on the first TLS handshake, so a hostname whose
// certificate was never issued still produces a bound listener: the panel would show a
// ready remote address while every public connection failed during the handshake.
func verifyCertificate(ctx context.Context, server *tsnet.Server, origin string, timeout time.Duration) error {
	host := strings.TrimPrefix(origin, "https://")
	if host == "" || host == origin || strings.ContainsAny(host, "/:") {
		return errors.New("invalid certificate host")
	}
	client, err := server.LocalClient()
	if err != nil {
		return err
	}
	fetchCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_, _, err = client.CertPair(fetchCtx, host)
	return certificateError(ctx, err)
}

// certificateError reports a fetch result without blaming the certificate for a stop the
// caller requested: the budget expiring under a live parent is a certificate failure, while
// a stopped parent is the clean stop serveFunnel already knows how to unwind.
func certificateError(ctx context.Context, fetchErr error) error {
	if fetchErr != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return fetchErr
}

func officialSetupURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "login.tailscale.com" || parsed.Port() != "" || parsed.User != nil {
		return ""
	}
	return parsed.String()
}

func queryFunnelSetupURL(ctx context.Context, server *tsnet.Server) string {
	client, err := server.LocalClient()
	if err != nil {
		return ""
	}
	info, err := client.QueryFeature(ctx, "funnel")
	if err != nil || info.Complete {
		return ""
	}
	return officialSetupURL(info.URL)
}

type controlStopCause uint8

const (
	controlStopped controlStopCause = iota
	controlParentCanceled
	controlEOF
	controlExtraCommand
)

// watchControlChannel ties the public listener lifetime to its parent process.
// It records whether serving stopped due to parent cancellation, control-channel
// EOF, an extra command, or an explicit local stop.
func watchControlChannel(parent context.Context, commands <-chan command) (context.Context, func() controlStopCause) {
	ctx, cancel := context.WithCancel(parent)
	stopRequested := make(chan struct{})
	done := make(chan struct{})
	cause := controlStopped
	go func() {
		defer close(done)
		select {
		case <-parent.Done():
			cause = controlParentCanceled
		case _, ok := <-commands:
			if ok {
				cause = controlExtraCommand
			} else if parent.Err() != nil {
				cause = controlParentCanceled
			} else {
				cause = controlEOF
			}
		case <-stopRequested:
			// Preserve a terminal external cause that was already observable
			// before the local stop request won the select.
			select {
			case _, ok := <-commands:
				if ok {
					cause = controlExtraCommand
				} else if parent.Err() != nil {
					cause = controlParentCanceled
				} else {
					cause = controlEOF
				}
			default:
				if parent.Err() != nil {
					cause = controlParentCanceled
				}
			}
		}
		cancel()
	}()
	var once sync.Once
	stop := func() controlStopCause {
		once.Do(func() { close(stopRequested) })
		<-done
		return cause
	}
	return ctx, stop
}

func serveHTTP(ctx context.Context, listener net.Listener, handler http.Handler) error {
	if err := ctx.Err(); err != nil {
		_ = listener.Close()
		return nil
	}
	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	serveDone := make(chan struct{})
	shutdownDone := make(chan struct{})
	var shutdownOnce sync.Once
	shutdown := func() {
		shutdownOnce.Do(func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = httpServer.Shutdown(shutdownCtx)
			_ = httpServer.Close()
			_ = listener.Close()
			close(shutdownDone)
		})
	}
	go func() {
		select {
		case <-ctx.Done():
			shutdown()
		case <-serveDone:
		}
	}()
	err := httpServer.Serve(listener)
	close(serveDone)
	shutdown()
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) || ctx.Err() != nil {
		return nil
	}
	return err
}

func serveFunnel(ctx context.Context, server *tsnet.Server, target *url.URL, origin string, output *reporter) error {
	if ctx.Err() != nil {
		return nil
	}
	listener, err := server.ListenFunnel("tcp", ":443", tsnet.FunnelOnly())
	if err != nil {
		return err
	}
	defer listener.Close()
	if ctx.Err() != nil {
		return nil
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(request *http.Request) {
		publicHost := request.Host
		director(request)
		request.Host = publicHost
	}
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(response, "gateway unavailable", http.StatusBadGateway)
	}

	if err := verifyCertificate(ctx, server, origin,
		resolveCertificateTimeout(os.Getenv("DSH_FUNNEL_CERTIFICATE_TIMEOUT_SECONDS"))); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("%w: %v", errCertificate, err)
	}
	if ctx.Err() != nil {
		// Stopped while the certificate was arriving: announce serving only for a live parent.
		return nil
	}
	output.emit(map[string]any{"type": "serving", "origin": origin})
	return serveHTTP(ctx, listener, proxy)
}

func run(arguments []string, input io.Reader, output io.Writer) int {
	reporter := &reporter{encoder: json.NewEncoder(output)}
	config, err := parseConfiguration(arguments)
	if err != nil {
		reporter.failure("invalid_arguments")
		return 2
	}
	if err := os.MkdirAll(config.stateDir, 0o700); err != nil {
		reporter.failure("state_directory_failed")
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &tsnet.Server{
		Dir:      config.stateDir,
		Hostname: config.hostname,
		UserLogf: reporter.userLogf,
		Logf:     func(string, ...any) {},
	}
	defer server.Close()
	status, err := server.Up(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		reporter.failure("tailscale_start_failed")
		return 1
	}
	if status.Self == nil {
		reporter.failure("tailscale_identity_missing")
		return 1
	}
	origin, err := publicOrigin(status.Self.DNSName)
	if err != nil {
		reporter.failure("tailscale_dns_missing")
		return 1
	}
	reporter.emit(map[string]any{"type": "ready", "origin": origin})
	commands := readCommands(ctx, input)
	target, err := waitForTarget(ctx, commands)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		reporter.failure("control_channel_failed")
		return 1
	}
	serveCtx, stopServing := watchControlChannel(ctx, commands)
	serveErr := serveFunnel(serveCtx, server, target, origin, reporter)
	stopCause := stopServing()
	if stopCause == controlExtraCommand {
		reporter.failure("control_channel_failed")
		return 1
	}
	if serveErr != nil {
		if stopCause == controlParentCanceled || stopCause == controlEOF {
			return 0
		}
		code, setupURL := classifyFunnelFailure(serveErr)
		if errors.Is(serveErr, errCertificate) {
			code, setupURL = "funnel_certificate_failed", ""
			// The control plane names HTTPS provisioning in the fetch error.
			if strings.Contains(serveErr.Error(), "https://tailscale.com/s/https") {
				code, setupURL = "funnel_https_required", "https://tailscale.com/s/https"
			}
		}
		if code == "funnel_permission_required" || code == "funnel_https_required" {
			if interactiveURL := queryFunnelSetupURL(ctx, server); interactiveURL != "" {
				setupURL = interactiveURL
			}
		}
		reporter.setupFailure(code, setupURL)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}
