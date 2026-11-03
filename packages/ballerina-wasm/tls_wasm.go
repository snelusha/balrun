package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

func upgradeClientTLS(ctx context.Context, conn net.Conn, address string, cfg pal.TLSConfig) (net.Conn, error) {
	if cfg.ServerName == "" {
		// tls.Client never derives ServerName from the dial address on its own.
		// Must be set before buildTLSConfig captures it for verification.
		if host, _, err := net.SplitHostPort(address); err == nil {
			cfg.ServerName = host
		} else {
			cfg.ServerName = address
		}
	}
	tlsConfig, err := buildTLSConfig(cfg)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return tlsClientHandshake(ctx, conn, tlsConfig, cfg.HandshakeTimeout)
}

// The functions below are copied from platform/palnative, whose helpers are
// unexported. TestTLSHelpersMatchUpstream fails when they drift apart.

// tlsClientHandshake upgrades conn to TLS, bounding the handshake by timeout
// when positive, and closes the connection if the handshake fails.
func tlsClientHandshake(ctx context.Context, conn net.Conn, cfg *tls.Config, timeout time.Duration) (*tls.Conn, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	tlsConn := tls.Client(conn, cfg)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = tlsConn.Close()
		return nil, err
	}
	return tlsConn, nil
}

// buildTLSConfig assembles a *tls.Config from a pal.TLSConfig, resolving CA
// pools, client certificates, SNI, cipher suites, and protocol version
// bounds. Shared by every native-CLI PAL category that opens a TLS
// connection. Fails closed on a malformed CA or client certificate: jBallerina's
// own TLS setup (netty's SslContextBuilder.trustManager/keyManager) throws
// immediately on invalid PEM material rather than silently falling back to
// the system trust store or an unauthenticated connection.
func buildTLSConfig(cfg pal.TLSConfig) (*tls.Config, error) {
	tlsConfig := &tls.Config{InsecureSkipVerify: cfg.InsecureSkipVerify} //nolint:gosec
	if len(cfg.CACertPEM) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(cfg.CACertPEM) {
			return nil, fmt.Errorf("failed to parse CA certificate PEM: no valid certificates found")
		}
		tlsConfig.RootCAs = pool
		if !cfg.InsecureSkipVerify {
			// Go 1.15+ requires SANs for hostname verification; many self-signed and
			// Java-issued certs only set the CN field. When a custom CA is provided
			// we do our own verification so CN-only certs are accepted as a fallback.
			tlsConfig.InsecureSkipVerify = true //nolint:gosec
			tlsConfig.VerifyConnection = tlsVerifyConnectionWithCNFallback(pool, cfg.ServerName)
		}
	}
	if cfg.SkipHostnameVerification && !cfg.InsecureSkipVerify {
		rootCAs := tlsConfig.RootCAs
		tlsConfig.InsecureSkipVerify = true //nolint:gosec
		tlsConfig.VerifyConnection = func(cs tls.ConnectionState) error {
			return tlsVerifyChain(rootCAs, cs)
		}
	}
	if len(cfg.ClientCertPEM) > 0 && len(cfg.ClientKeyPEM) > 0 {
		cert, err := tls.X509KeyPair(cfg.ClientCertPEM, cfg.ClientKeyPEM)
		if err != nil {
			return nil, fmt.Errorf("failed to load client certificate: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{cert}
	}
	tlsConfig.ServerName = cfg.ServerName
	tlsConfig.SessionTicketsDisabled = cfg.DisableSessionTickets
	tlsConfig.MinVersion = tls.VersionTLS12 // secure default; overridden below if configured
	if cfg.MinVersion != 0 {
		tlsConfig.MinVersion = cfg.MinVersion
	}
	if cfg.MaxVersion != 0 {
		tlsConfig.MaxVersion = cfg.MaxVersion
	}
	if len(cfg.CipherSuiteNames) > 0 {
		if resolved := resolveCipherSuites(cfg.CipherSuiteNames); len(resolved) > 0 {
			tlsConfig.CipherSuites = resolved
		} else {
			_, _ = fmt.Fprintf(os.Stderr, "warning: no valid cipher suites resolved from cfg.CipherSuiteNames %v; keeping secure defaults\n", cfg.CipherSuiteNames)
		}
	}
	return tlsConfig, nil
}

// buildServerTLSConfig assembles a *tls.Config from the pre-read PEM material
// and settings carried by pal.ServerTLSConfig.
func buildServerTLSConfig(c *pal.ServerTLSConfig) (*tls.Config, error) {
	cert, err := tls.X509KeyPair(c.CertPEM, c.KeyPEM)
	if err != nil {
		return nil, fmt.Errorf("X509KeyPair: %w", err)
	}
	tlsCfg := &tls.Config{Certificates: []tls.Certificate{cert}} //nolint:gosec

	// mTLS: client certificate verification.
	if len(c.ClientCACertPEM) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(c.ClientCACertPEM) {
			return nil, fmt.Errorf("failed to parse CA certificate")
		}
		tlsCfg.ClientCAs = pool
		tlsCfg.ClientAuth = tls.RequireAndVerifyClientCert
	}

	tlsCfg.MinVersion = c.MinVersion
	tlsCfg.MaxVersion = c.MaxVersion
	if len(c.CipherSuiteNames) > 0 {
		if resolved := resolveCipherSuites(c.CipherSuiteNames); len(resolved) > 0 {
			tlsCfg.CipherSuites = resolved
		}
	}
	tlsCfg.SessionTicketsDisabled = c.DisableSessionTickets
	return tlsCfg, nil
}

// resolveCipherSuites maps IANA TLS 1.2 cipher suite names to Go uint16 IDs.
// Unknown names are silently skipped; TLS 1.3 ciphers are unaffected regardless.
func resolveCipherSuites(names []string) []uint16 {
	m := make(map[string]uint16, len(tls.CipherSuites())+len(tls.InsecureCipherSuites()))
	for _, c := range tls.CipherSuites() {
		m[c.Name] = c.ID
	}
	for _, c := range tls.InsecureCipherSuites() {
		m[c.Name] = c.ID
	}
	ids := make([]uint16, 0, len(names))
	for _, name := range names {
		if id, ok := m[name]; ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// tlsVerifyChain verifies the server's certificate chain against rootCAs (the
// system pool when nil) without checking the hostname.
func tlsVerifyChain(rootCAs *x509.CertPool, cs tls.ConnectionState) error {
	if len(cs.PeerCertificates) == 0 {
		return fmt.Errorf("x509: server presented no certificates")
	}
	opts := x509.VerifyOptions{
		Roots:         rootCAs,
		Intermediates: x509.NewCertPool(),
	}
	for _, cert := range cs.PeerCertificates[1:] {
		opts.Intermediates.AddCert(cert)
	}
	_, err := cs.PeerCertificates[0].Verify(opts)
	return err
}

// tlsVerifyConnectionWithCNFallback returns a VerifyConnection callback that verifies the
// server's certificate chain against rootCAs and falls back to CN-based hostname matching
// when no SANs are present. Go 1.15+ disabled CN-only hostname verification (RFC 6125 §2.3),
// but many self-signed and Java-issued certificates still rely on it.
//
// The hostname is checked against expectedServerName when set, else cs.ServerName, which
// Go leaves empty for IP literals since it never sends SNI for them (RFC 6066). Callers
// that know the dialed host pass it as expectedServerName; the cs.ServerName fallback only
// serves proxied HTTPS, where http.Transport runs the handshake itself. An empty name is
// rejected: matching it would accept any trusted certificate with no SANs and an empty CN.
func tlsVerifyConnectionWithCNFallback(rootCAs *x509.CertPool, expectedServerName string) func(tls.ConnectionState) error {
	return func(cs tls.ConnectionState) error {
		serverName := expectedServerName
		if serverName == "" {
			serverName = cs.ServerName
		}
		if serverName == "" {
			return fmt.Errorf("x509: cannot verify certificate hostname: no server name")
		}
		if err := tlsVerifyChain(rootCAs, cs); err != nil {
			return err
		}
		// Try SAN-based verification first. Only fall back to CN matching for
		// certs that genuinely have no SANs — when SANs are present but don't
		// match, that is a real mismatch and must not be bypassed.
		leaf := cs.PeerCertificates[0]
		if err := leaf.VerifyHostname(serverName); err != nil {
			if len(leaf.DNSNames) > 0 || len(leaf.IPAddresses) > 0 {
				return err
			}
			return tlsMatchCN(leaf.Subject.CommonName, serverName)
		}
		return nil
	}
}

// tlsMatchCN checks whether pattern (a certificate CN) matches host.
// Supports simple wildcard patterns of the form "*.example.com".
func tlsMatchCN(pattern, host string) error {
	pattern = strings.ToLower(strings.TrimSuffix(pattern, "."))
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if pattern == host {
		return nil
	}
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.com"
		if strings.HasSuffix(host, suffix) && strings.Count(host, ".") == strings.Count(suffix, ".") {
			return nil
		}
	}
	return fmt.Errorf("x509: certificate CN %q does not match host %q", pattern, host)
}
