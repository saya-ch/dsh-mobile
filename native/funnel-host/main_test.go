package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestClassifyFunnelFailure(t *testing.T) {
	tests := []struct {
		name      string
		message   string
		wantCode  string
		wantSetup string
	}{
		{
			name:      "funnel permission",
			message:   `Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel.`,
			wantCode:  "funnel_permission_required",
			wantSetup: "https://tailscale.com/s/no-funnel",
		},
		{
			name:      "https permission",
			message:   "Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https.",
			wantCode:  "funnel_https_required",
			wantSetup: "https://tailscale.com/s/https",
		},
		{
			name:     "unknown failure",
			message:  "listener failed",
			wantCode: "funnel_start_failed",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, setupURL := classifyFunnelFailure(errors.New(test.message))
			if code != test.wantCode || setupURL != test.wantSetup {
				t.Fatalf("classifyFunnelFailure() = (%q, %q), want (%q, %q)", code, setupURL, test.wantCode, test.wantSetup)
			}
		})
	}
}

func TestReadCommandsCancellationClosesInput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	defer writer.Close()
	commands := readCommands(ctx, reader)
	cancel()
	select {
	case _, ok := <-commands:
		if ok {
			t.Fatal("unexpected command after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("command reader remained blocked after cancellation")
	}
}

func TestControlEOFRevokesServeContext(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	reader, writer := io.Pipe()
	defer reader.Close()
	commands := readCommands(parent, reader)
	if err := json.NewEncoder(writer).Encode(command{Version: protocolVersion, Type: "serve", Target: "http://127.0.0.1:1234"}); err != nil {
		t.Fatal(err)
	}
	if _, err := waitForTarget(parent, commands); err != nil {
		t.Fatal(err)
	}
	serveCtx, stop := watchControlChannel(parent, commands)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-serveCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("serve context remained active after parent stdin EOF")
	}
	if cause := stop(); cause != controlEOF {
		t.Fatalf("stop cause = %v, want controlEOF", cause)
	}
	if cause := stop(); cause != controlEOF {
		t.Fatalf("idempotent stop cause = %v, want controlEOF", cause)
	}
}

func TestParentCancellationStopsServeContextCleanly(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	defer writer.Close()
	serveCtx, stop := watchControlChannel(parent, readCommands(parent, reader))
	cancelParent()
	select {
	case <-serveCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("serve context remained active after parent cancellation")
	}
	if cause := stop(); cause != controlParentCanceled {
		t.Fatalf("stop cause = %v, want controlParentCanceled", cause)
	}
}

func TestExtraControlCommandRevokesServeContext(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	commands := readCommands(parent, reader)
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(command{Version: protocolVersion, Type: "serve", Target: "http://127.0.0.1:1234"}); err != nil {
		t.Fatal(err)
	}
	if _, err := waitForTarget(parent, commands); err != nil {
		t.Fatal(err)
	}
	serveCtx, stop := watchControlChannel(parent, commands)
	if err := encoder.Encode(command{Version: protocolVersion, Type: "serve", Target: "http://127.0.0.1:1234"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-serveCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("serve context remained active after an extra control command")
	}
	if cause := stop(); cause != controlExtraCommand {
		t.Fatalf("stop cause = %v, want controlExtraCommand", cause)
	}
	if cause := stop(); cause != controlExtraCommand {
		t.Fatalf("idempotent stop cause = %v, want controlExtraCommand", cause)
	}
}

func TestExplicitControlStopHasLocalCause(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	serveCtx, stop := watchControlChannel(parent, make(chan command))
	if cause := stop(); cause != controlStopped {
		t.Fatalf("stop cause = %v, want controlStopped", cause)
	}
	select {
	case <-serveCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("serve context remained active after explicit stop")
	}
}

func TestServeHTTPStopsPromptlyAndIdempotently(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveHTTP(ctx, listener, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusNoContent)
		}))
	}()
	response, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	cancel()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveHTTP() after cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serveHTTP did not stop promptly")
	}
	if connection, err := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond); err == nil {
		connection.Close()
		t.Fatal("listener still accepted connections after cancellation")
	}
}

type failAfterFirstListener struct {
	net.Listener
	mu       sync.Mutex
	accepted bool
	fail     <-chan struct{}
	err      error
}

func (l *failAfterFirstListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if !l.accepted {
		l.accepted = true
		l.mu.Unlock()
		return l.Listener.Accept()
	}
	l.mu.Unlock()
	<-l.fail
	return nil, l.err
}

func TestServeHTTPClosesActiveConnectionAfterUnexpectedServeFailure(t *testing.T) {
	baseListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	failure := make(chan struct{})
	forcedErr := errors.New("forced listener failure")
	listener := &failAfterFirstListener{
		Listener: baseListener,
		fail:     failure,
		err:      forcedErr,
	}
	handlerStarted := make(chan struct{})
	handlerDone := make(chan struct{})
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- serveHTTP(context.Background(), listener, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
			close(handlerStarted)
			<-request.Context().Done()
			close(handlerDone)
		}))
	}()

	connection, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, "GET / HTTP/1.1\r\nHost: test\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-handlerStarted:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}
	close(failure)

	select {
	case err := <-serveDone:
		if !errors.Is(err, forcedErr) {
			t.Fatalf("serveHTTP() = %v, want %v", err, forcedErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serveHTTP did not finish within bounded shutdown timeout")
	}
	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("active handler remained blocked after Serve failure")
	}
	if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Read(make([]byte, 1)); err == nil {
		t.Fatal("active connection remained open after Serve failure")
	}
	if connection, err := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond); err == nil {
		connection.Close()
		t.Fatal("listener still accepted connections after Serve failure")
	}
}

func TestOfficialSetupURL(t *testing.T) {
	valid := "https://login.tailscale.com/admin/feature/funnel?node=node-1"
	if got := officialSetupURL(valid); got != valid {
		t.Fatalf("officialSetupURL() = %q, want %q", got, valid)
	}
	for _, invalid := range []string{
		"http://login.tailscale.com/admin/feature/funnel",
		"https://example.com/admin/feature/funnel",
		"https://login.tailscale.com.evil.example/admin/feature/funnel",
		"https://user@login.tailscale.com/admin/feature/funnel",
	} {
		if got := officialSetupURL(invalid); got != "" {
			t.Fatalf("officialSetupURL(%q) = %q, want empty", invalid, got)
		}
	}
}

func TestVerifyCertificateRejectsAnOriginThatCannotNameACertificate(t *testing.T) {
	// The public origin is the only place a certificate name may come from; anything
	// else would let the sidecar ask the control plane for an unrelated certificate.
	for _, origin := range []string{"", "https://", "http://example.ts.net", "example.ts.net", "https://example.ts.net/path", "https://example.ts.net:443"} {
		if err := verifyCertificate(context.Background(), nil, origin, defaultCertificateTimeout); err == nil {
			t.Fatalf("verifyCertificate(%q) accepted an invalid origin", origin)
		}
	}
}

func TestCertificateTimeoutDefaultsGenerouslyAndIsOverridable(t *testing.T) {
	// A cold ACME issuance measured ~39s on a slow public route; the default must clear
	// that comfortably, and an operator must be able to widen it without a rebuild.
	if defaultCertificateTimeout < 90*time.Second {
		t.Fatalf("default certificate timeout %v is below the measured issuance time", defaultCertificateTimeout)
	}
	cases := []struct {
		raw  string
		want time.Duration
	}{
		{"", defaultCertificateTimeout},
		{"   ", defaultCertificateTimeout},
		{"abc", defaultCertificateTimeout},
		{"-5", defaultCertificateTimeout},
		{"0", defaultCertificateTimeout},
		{"39", 39 * time.Second},
		{"600", 600 * time.Second},
		{"5", minCertificateTimeout},
		{"100000", maxCertificateTimeout},
	}
	for _, c := range cases {
		if got := resolveCertificateTimeout(c.raw); got != c.want {
			t.Fatalf("resolveCertificateTimeout(%q) = %v, want %v", c.raw, got, c.want)
		}
	}
}

func TestCertificateFailureIsReportedInsteadOfServing(t *testing.T) {
	// tsnet resolves the certificate lazily, so a bound listener alone must not be
	// announced: the panel would show a ready address while every handshake failed.
	cause := fmt.Errorf("%w: acme: no certificate for dsh-example.ts.net", errCertificate)
	if !errors.Is(cause, errCertificate) {
		t.Fatal("wrapped certificate failure lost its sentinel")
	}
	code, setupURL := classifyFunnelFailure(cause)
	if code != "funnel_start_failed" || setupURL != "" {
		t.Fatalf("classifyFunnelFailure() = (%q, %q), want the generic start failure", code, setupURL)
	}
}
