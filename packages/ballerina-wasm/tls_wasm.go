package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

// The TLS assembly below mirrors platform/palnative (tls.go, http.go and
// httpserver.go), whose helpers are unexported. Keep it in step with upstream so
// that certificate verification behaves the same on both platforms.

func upgradeClientTLS(ctx context.Context, conn net.Conn, address string, cfg pal.TLSConfig) (net.Conn, error) {
	if cfg.ServerName == "" {
		// tls.Client never derives ServerName from the dial address on its own.
		// Must be set before buildClientTLSConfig captures it for verification.
		if host, _, err := net.SplitHostPort(address); err == nil {
			cfg.ServerName = host
		} else {
			cfg.ServerName = address
		}
	}
	tlsConfig, err := buildClientTLSConfig(cfg)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if cfg.HandshakeTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, cfg.HandshakeTimeout)
		defer cancel()
	}
	tlsConn := tls.Client(conn, tlsConfig)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = tlsConn.Close()
		return nil, err
	}
	return tlsConn, nil
}

func buildClientTLSConfig(cfg pal.TLSConfig) (*tls.Config, error) {
	tlsConfig := &tls.Config{InsecureSkipVerify: cfg.InsecureSkipVerify} //nolint:gosec
	if len(cfg.CACertPEM) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(cfg.CACertPEM) {
			return nil, fmt.Errorf("failed to parse CA certificate PEM: no valid certificates found")
		}
		tlsConfig.RootCAs = pool
		if !cfg.InsecureSkipVerify {
			tlsConfig.InsecureSkipVerify = true //nolint:gosec
			tlsConfig.VerifyConnection = verifyConnectionWithCNFallback(pool, cfg.ServerName)
		}
	}
	if cfg.SkipHostnameVerification && !cfg.InsecureSkipVerify {
		rootCAs := tlsConfig.RootCAs
		tlsConfig.InsecureSkipVerify = true //nolint:gosec
		tlsConfig.VerifyConnection = func(cs tls.ConnectionState) error {
			return verifyCertificateChain(rootCAs, cs)
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
	tlsConfig.MinVersion = tls.VersionTLS12
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
			_, _ = fmt.Fprintf(os.Stderr, "warning: no valid cipher suites resolved from %v; keeping secure defaults\n", cfg.CipherSuiteNames)
		}
	}
	return tlsConfig, nil
}

func buildServerTLSConfig(cfg *pal.ServerTLSConfig) (*tls.Config, error) {
	cert, err := tls.X509KeyPair(cfg.CertPEM, cfg.KeyPEM)
	if err != nil {
		return nil, fmt.Errorf("X509KeyPair: %w", err)
	}
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{cert}} //nolint:gosec
	if len(cfg.ClientCACertPEM) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(cfg.ClientCACertPEM) {
			return nil, fmt.Errorf("failed to parse CA certificate")
		}
		tlsConfig.ClientCAs = pool
		tlsConfig.ClientAuth = tls.RequireAndVerifyClientCert
	}
	tlsConfig.MinVersion = cfg.MinVersion
	tlsConfig.MaxVersion = cfg.MaxVersion
	if len(cfg.CipherSuiteNames) > 0 {
		if resolved := resolveCipherSuites(cfg.CipherSuiteNames); len(resolved) > 0 {
			tlsConfig.CipherSuites = resolved
		}
	}
	tlsConfig.SessionTicketsDisabled = cfg.DisableSessionTickets
	return tlsConfig, nil
}

func resolveCipherSuites(names []string) []uint16 {
	known := make(map[string]uint16, len(tls.CipherSuites())+len(tls.InsecureCipherSuites()))
	for _, suite := range tls.CipherSuites() {
		known[suite.Name] = suite.ID
	}
	for _, suite := range tls.InsecureCipherSuites() {
		known[suite.Name] = suite.ID
	}
	ids := make([]uint16, 0, len(names))
	for _, name := range names {
		if id, ok := known[name]; ok {
			ids = append(ids, id)
		}
	}
	return ids
}

func verifyCertificateChain(rootCAs *x509.CertPool, cs tls.ConnectionState) error {
	if len(cs.PeerCertificates) == 0 {
		return fmt.Errorf("x509: server presented no certificates")
	}
	opts := x509.VerifyOptions{Roots: rootCAs, Intermediates: x509.NewCertPool()}
	for _, cert := range cs.PeerCertificates[1:] {
		opts.Intermediates.AddCert(cert)
	}
	_, err := cs.PeerCertificates[0].Verify(opts)
	return err
}

// verifyConnectionWithCNFallback falls back to CN matching only for certificates
// with no SANs at all; a SAN mismatch is a real mismatch. IP literals leave
// cs.ServerName empty, so the dialed host is passed in, and an empty name is
// rejected rather than matching a certificate with an empty CN.
func verifyConnectionWithCNFallback(rootCAs *x509.CertPool, expectedServerName string) func(tls.ConnectionState) error {
	return func(cs tls.ConnectionState) error {
		serverName := expectedServerName
		if serverName == "" {
			serverName = cs.ServerName
		}
		if serverName == "" {
			return fmt.Errorf("x509: cannot verify certificate hostname: no server name")
		}
		if err := verifyCertificateChain(rootCAs, cs); err != nil {
			return err
		}
		leaf := cs.PeerCertificates[0]
		if err := leaf.VerifyHostname(serverName); err != nil {
			if len(leaf.DNSNames) > 0 || len(leaf.IPAddresses) > 0 {
				return err
			}
			return matchCommonName(leaf.Subject.CommonName, serverName)
		}
		return nil
	}
}

func matchCommonName(pattern, host string) error {
	pattern = strings.ToLower(strings.TrimSuffix(pattern, "."))
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if pattern == host {
		return nil
	}
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:]
		if strings.HasSuffix(host, suffix) && strings.Count(host, ".") == strings.Count(suffix, ".") {
			return nil
		}
	}
	return fmt.Errorf("x509: certificate CN %q does not match host %q", pattern, host)
}
