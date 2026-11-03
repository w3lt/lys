//! A certificate authority of the tests: a root the trust can be told
//! about, and server certificates for localhost signed by it, each valid
//! from the day before the test runs to a year after it.

use std::sync::Arc;

use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, date_time_ymd,
};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::crypto::ring;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use super::{SECONDS_PER_DAY, calculate_civil_day, get_current_timestamp};

/// Days a certificate stays valid after the day the test runs.
const VALIDITY_DAYS: i64 = 365;

/// A root certificate and the key signing server certificates with it.
///
/// Concurrency model: reentrant; it changes nothing after it is created,
/// and each acceptor it builds has a certificate of its own. Resource
/// ownership: it holds no resource, only the key and the root in memory.
pub struct TestAuthority {
    /// The root certificate, DER.
    pub root: CertificateDer<'static>,
    /// The issuer signing server certificates.
    issuer: Issuer<'static, KeyPair>,
}

impl Default for TestAuthority {
    fn default() -> Self {
        Self::new()
    }
}

impl TestAuthority {
    /// Creates a fresh authority with its own key.
    pub fn new() -> Self {
        let mut params = CertificateParams::new(Vec::<String>::new()).expect("CA parameters");
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        update_validity_from_today(&mut params);
        params
            .distinguished_name
            .push(DnType::CommonName, "Lys test authority");
        let key = KeyPair::generate().expect("CA key");
        let root = params
            .self_signed(&key)
            .expect("root certificate")
            .der()
            .clone();
        Self {
            root,
            issuer: Issuer::new(params, key),
        }
    }

    /// Builds a TLS acceptor serving a certificate for localhost signed by
    /// this authority.
    pub fn build_acceptor(&self) -> TlsAcceptor {
        let mut params =
            CertificateParams::new(vec!["localhost".to_owned(), "127.0.0.1".to_owned()])
                .expect("server parameters");
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        update_validity_from_today(&mut params);
        params
            .distinguished_name
            .push(DnType::CommonName, "localhost");
        let key = KeyPair::generate().expect("server key");
        let certificate = params
            .signed_by(&key, &self.issuer)
            .expect("server certificate");
        let chain = vec![certificate.der().clone(), self.root.clone()];
        let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
        let config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_no_client_auth()
            .with_single_cert(chain, private_key)
            .expect("server configuration");
        TlsAcceptor::from(Arc::new(config))
    }
}

/// Makes certificate parameters valid from the day before today, in UTC,
/// so that a clock a little behind still accepts them, to
/// [`VALIDITY_DAYS`] after today.
///
/// # Arguments
///
/// * `params` - The parameters to change.
fn update_validity_from_today(params: &mut CertificateParams) {
    let today = get_current_timestamp().div_euclid(SECONDS_PER_DAY);
    let (year, month, day) = calculate_certificate_day(today - 1);
    params.not_before = date_time_ymd(year, month, day);
    let (year, month, day) = calculate_certificate_day(today + VALIDITY_DAYS);
    params.not_after = date_time_ymd(year, month, day);
}

/// Converts days since the Unix epoch to the calendar day rcgen takes.
///
/// # Arguments
///
/// * `days` - Days since the Unix epoch.
fn calculate_certificate_day(days: i64) -> (i32, u8, u8) {
    let (year, month, day) = calculate_civil_day(days);
    (i32::try_from(year).expect("a year rcgen takes"), month, day)
}
