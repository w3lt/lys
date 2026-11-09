//! Which server certificates the server accepts.
//!
//! Every TLS connection is verified by the operating system's certificate
//! store through `rustls-platform-verifier`: through the connector built
//! here for IMAP and for SMTP protected from its first byte, and through
//! lettre, which uses the same verifier, for SMTP's STARTTLS. Tests add
//! their own root certificate; the server itself adds none.

use std::error::Error;
use std::io;
use std::sync::Arc;

use lettre::transport::smtp::client::{Certificate, TlsParameters};
use rustls_platform_verifier::Verifier;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::crypto::ring;
use tokio_rustls::rustls::pki_types::CertificateDer;
use tokio_rustls::rustls::{ClientConfig, Error as TlsError};

/// The certificate trust of this process: the operating system's store,
/// plus the extra roots given to it.
///
/// Concurrency model: reentrant; it holds no mutable state, and each build
/// makes a new connector or new parameters. Resource ownership: it holds
/// no resource, only the extra roots' bytes.
#[derive(Clone, Debug, Default)]
pub struct Trust {
    /// Roots trusted besides the operating system's, in DER form.
    extra_roots: Vec<CertificateDer<'static>>,
}

impl Trust {
    /// Creates the trust the server runs with: the operating system's
    /// store and nothing else.
    pub fn create_platform() -> Self {
        Self::default()
    }

    /// Creates a trust that also accepts certificates issued by the given
    /// roots, for tests with their own certificate authority.
    ///
    /// # Arguments
    ///
    /// * `extra_roots` - Root certificates in DER form.
    pub fn create_with_extra_roots(extra_roots: Vec<CertificateDer<'static>>) -> Self {
        Self { extra_roots }
    }

    /// Builds the TLS connector for connections protected from their first
    /// byte, IMAP's and SMTP's, and for IMAP's STARTTLS.
    ///
    /// # Returns
    ///
    /// The connector, or the TLS library's error when the verifier or the
    /// configuration cannot be built, which no account can cause.
    pub fn build_tls_connector(&self) -> Result<TlsConnector, TlsError> {
        let provider = Arc::new(ring::default_provider());
        let verifier = Verifier::new_with_extra_roots(
            self.extra_roots.iter().cloned(),
            Arc::clone(&provider),
        )?;
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        Ok(TlsConnector::from(Arc::new(config)))
    }

    /// Builds the TLS parameters lettre verifies an SMTP connection's
    /// STARTTLS with.
    ///
    /// # Arguments
    ///
    /// * `server_name` - The host name, or IP address, the certificate must
    ///   be issued for.
    ///
    /// # Returns
    ///
    /// The parameters, or lettre's error when the configuration cannot be
    /// built, which no account can cause.
    pub fn build_smtp_parameters(
        &self,
        server_name: &str,
    ) -> Result<TlsParameters, lettre::transport::smtp::Error> {
        let mut builder = TlsParameters::builder(server_name.to_owned());
        for root in &self.extra_roots {
            builder = builder.add_root_certificate(Certificate::from_der(root.to_vec())?);
        }
        builder.build_rustls()
    }
}

/// Whether an error, or any error it came from, is the TLS library's
/// refusal of the server's certificate.
///
/// The TLS library's error is found directly in the chain, or inside an
/// I/O error, whose own chain skips it.
///
/// # Arguments
///
/// * `error` - The error to inspect.
pub fn is_certificate_refusal(error: &(dyn Error + 'static)) -> bool {
    let mut current: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(candidate) = current {
        if let Some(tls) = candidate.downcast_ref::<TlsError>() {
            return matches!(tls, TlsError::InvalidCertificate(_));
        }
        if let Some(io) = candidate.downcast_ref::<io::Error>()
            && let Some(inner) = io.get_ref()
            && let Some(tls) = inner.downcast_ref::<TlsError>()
        {
            return matches!(tls, TlsError::InvalidCertificate(_));
        }
        current = candidate.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
    use tokio_rustls::rustls::CertificateError;

    #[test]
    fn finds_a_certificate_refusal_inside_an_io_error() {
        let refusal = TlsError::InvalidCertificate(CertificateError::UnknownIssuer);
        let io = io::Error::new(io::ErrorKind::InvalidData, refusal);

        assert!(is_certificate_refusal(&io));
        assert!(!is_certificate_refusal(&io::Error::new(
            io::ErrorKind::ConnectionReset,
            "reset"
        )));
        assert!(!is_certificate_refusal(&io::Error::new(
            io::ErrorKind::InvalidData,
            TlsError::HandshakeNotComplete
        )));
    }

    #[test]
    fn builds_a_connector_and_parameters_with_an_extra_root() {
        let key = KeyPair::generate().expect("root key");
        let mut params = CertificateParams::new(Vec::<String>::new()).expect("root parameters");
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let root = params.self_signed(&key).expect("root certificate");
        let trust = Trust::create_with_extra_roots(vec![root.der().clone()]);

        assert!(trust.build_tls_connector().is_ok());
        assert!(trust.build_smtp_parameters("smtp.example.com").is_ok());
    }
}
