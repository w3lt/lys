//! The `email` binary as the integration tests run it, and this test
//! binary run again for one of its cases: one process for a test, its
//! standard streams piped or its output a pipe without a reader, ended on
//! every path the test takes, and waited for only within a bound.

use std::env;
use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Read};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Longest a binary may take, in real time, for one step of a test: to
/// answer a request, to bring a call to the fault a fake holds it at, to
/// exit once its input ended or the one case it runs ended, or to close
/// its output once it exited.
pub const STEP_WAIT_LIMIT: Duration = Duration::from_secs(30);

/// The standard streams of a started binary, each piped to the test.
pub struct BinaryStreams {
    /// Its standard input; dropping it ends the binary's input.
    pub input: ChildStdin,
    /// Its standard output, where the `email` binary answers and this test
    /// binary reports the case it ran.
    pub output: ChildStdout,
    /// Its standard error, where it logs.
    pub log: ChildStderr,
}

/// The process of a binary started for one test: the `email` binary, or
/// this test binary running one of its cases again.
///
/// Owns the process of the binary one test runs. Invariant: once the value
/// is gone, the process has ended and is reaped: [`Self::wait_for_exit`]
/// reaps it after it exited, [`Self::stop`] kills and reaps it, and
/// dropping the value before either did, as a test whose step failed first
/// does, kills and reaps it. Concurrency model: single-owner; the thread
/// that runs the test's dialogue with the binary holds it. Resource
/// ownership: the process is the test's direct child and the whole scope,
/// as neither the `email` binary nor a case run again starts a process of
/// its own; [`Self::start`] and [`Self::start_test_case`] hand its
/// standard streams to the test, and
/// [`Self::start_with_output_reader_closed`] its standard error; the
/// process's end closes them, which ends every read of them.
pub struct BinaryProcess {
    /// The process.
    child: Child,
}

impl BinaryProcess {
    /// Starts the binary with its standard streams piped; from then on,
    /// the value ends it whatever the test does next.
    ///
    /// # Arguments
    ///
    /// * `arguments` - The binary's command-line arguments.
    /// * `variable` - The value of `LYS_EMAIL_ACCOUNT`, which need not be
    ///   Unicode text, or `None` to start the binary without the variable.
    ///
    /// # Returns
    ///
    /// The process and its standard streams.
    ///
    /// # Panics
    ///
    /// When the binary cannot be started.
    pub fn start(arguments: &[&str], variable: Option<&OsStr>) -> (Self, BinaryStreams) {
        Self::start_piped(build_email_binary_command(arguments, variable))
    }

    /// Starts the binary with its standard input ended, its standard error
    /// piped, and its standard output a pipe whose reader closed before the
    /// binary started, so that each write to that output fails with a
    /// broken pipe; from then on, the value ends it whatever the test does
    /// next.
    ///
    /// # Arguments
    ///
    /// * `arguments` - The binary's command-line arguments.
    /// * `variable` - The value of `LYS_EMAIL_ACCOUNT`, which need not be
    ///   Unicode text, or `None` to start the binary without the variable.
    ///
    /// # Returns
    ///
    /// The process and its standard error.
    ///
    /// # Panics
    ///
    /// When the pipe cannot be made or the binary cannot be started.
    pub fn start_with_output_reader_closed(
        arguments: &[&str],
        variable: Option<&OsStr>,
    ) -> (Self, ChildStderr) {
        let (reader, writer) = io::pipe().expect("a pipe");
        drop(reader);
        let mut command = build_email_binary_command(arguments, variable);
        command
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(Stdio::piped());
        let mut process = Self {
            child: command.spawn().expect("the binary starts"),
        };
        let log = process.child.stderr.take().expect("standard error");
        (process, log)
    }

    /// Starts this test binary again, running only one of its cases, with
    /// its standard streams piped; from then on, the value ends it
    /// whatever the test does next.
    ///
    /// # Arguments
    ///
    /// * `case` - The case's path in this test binary, such as
    ///   `check::accepts_an_smtp_sign_in_whose_quit_fails`. The case must
    ///   start no process of its own, so that ending this process ends
    ///   everything the run started.
    ///
    /// # Returns
    ///
    /// The process and its standard streams: the test harness reports the
    /// case on its standard output, and what the case's code writes to
    /// standard error stays in its standard error.
    ///
    /// # Panics
    ///
    /// When the path of this test binary cannot be read, or the binary
    /// cannot be started.
    pub fn start_test_case(case: &str) -> (Self, BinaryStreams) {
        let mut command = Command::new(env::current_exe().expect("the path of this test binary"));
        command.args([case, "--exact", "--test-threads=1", "--color=never"]);
        Self::start_piped(command)
    }

    /// Starts the command with its standard streams piped; from then on,
    /// the value ends it whatever the test does next.
    ///
    /// # Returns
    ///
    /// The process and its standard streams.
    ///
    /// # Panics
    ///
    /// When the command cannot be started.
    fn start_piped(mut command: Command) -> (Self, BinaryStreams) {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut process = Self {
            child: command.spawn().expect("the binary starts"),
        };
        let streams = BinaryStreams {
            input: process.child.stdin.take().expect("standard input"),
            output: process.child.stdout.take().expect("standard output"),
            log: process.child.stderr.take().expect("standard error"),
        };
        (process, streams)
    }

    /// Waits, at most [`STEP_WAIT_LIMIT`] in real time, for the binary to exit,
    /// and reaps it.
    ///
    /// # Returns
    ///
    /// How the binary exited.
    ///
    /// # Panics
    ///
    /// When the binary does not exit in time, or its state cannot be read;
    /// dropping the process as the panic unwinds then kills and reaps it.
    pub fn wait_for_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + STEP_WAIT_LIMIT;
        loop {
            /// How long [`BinaryProcess::wait_for_exit`] sleeps between two
            /// looks at the binary.
            const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

            let exited = self.child.try_wait().expect("the binary's state is read");
            if let Some(status) = exited {
                return status;
            }
            if Instant::now() >= deadline {
                panic!(
                    "the binary did not exit within {} seconds",
                    STEP_WAIT_LIMIT.as_secs()
                );
            }
            thread::sleep(EXIT_POLL_INTERVAL);
        }
    }

    /// Kills the binary and reaps it.
    ///
    /// # Panics
    ///
    /// When the binary cannot be killed or reaped.
    pub fn stop(mut self) {
        self.child.kill().expect("the binary is killed");
        self.child.wait().expect("the binary is reaped");
    }
}

/// Builds the command that runs the `email` binary.
///
/// # Arguments
///
/// * `arguments` - The binary's command-line arguments.
/// * `variable` - The value of `LYS_EMAIL_ACCOUNT`, which need not be
///   Unicode text, or `None` to run the binary without the variable.
fn build_email_binary_command(arguments: &[&str], variable: Option<&OsStr>) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_email"));
    command.args(arguments);
    match variable {
        Some(value) => command.env("LYS_EMAIL_ACCOUNT", value),
        None => command.env_remove("LYS_EMAIL_ACCOUNT"),
    };
    command
}

impl Drop for BinaryProcess {
    /// Kills and reaps the binary when neither [`BinaryProcess::wait_for_exit`]
    /// nor [`BinaryProcess::stop`] ended it, as when a step of the test
    /// failed first; once either did, the process is reaped and nothing is
    /// sent to it. A failure to end it goes to standard error, so that the
    /// test's own failure stays the one it reports.
    fn drop(&mut self) {
        if let Err(error) = self.child.kill().and_then(|()| self.child.wait()) {
            eprintln!("the binary could not be killed and reaped: {error}");
        }
    }
}

/// Follows a stream of the binary on a thread of its own, line by line,
/// until the binary closes it or the receiver is gone.
///
/// # Returns
///
/// The receiver of the lines, without their line ends, as they come.
pub fn follow_lines(stream: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || send_lines(BufReader::new(stream), &sender));
    receiver
}

/// Sends each line the reader gives to the receiver, until the reader
/// ends or fails, or the receiver is gone.
fn send_lines(reader: impl BufRead, sender: &mpsc::Sender<String>) {
    for line in reader.lines().map_while(Result::ok) {
        if sender.send(line).is_err() {
            return;
        }
    }
}

/// Reads a stream of the binary to its end on a thread of its own, so that
/// the binary never waits for room in a full pipe.
///
/// # Returns
///
/// The receiver of the stream's bytes, or of why reading it failed, once
/// the binary closed it; a receiver that is gone no longer wants them.
pub fn read_to_end_in_thread(
    mut stream: impl Read + Send + 'static,
) -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        sender.send(stream.read_to_end(&mut bytes).map(|_| bytes))
    });
    receiver
}

/// Waits, at most [`STEP_WAIT_LIMIT`] in real time, for the end of a stream that
/// [`read_to_end_in_thread`] reads.
///
/// # Arguments
///
/// * `bytes` - Gives the stream's bytes once the binary closed it.
/// * `stream` - The stream's name, for the panic.
///
/// # Returns
///
/// The stream's bytes.
///
/// # Panics
///
/// When the stream does not end in time, or reading it failed.
pub fn wait_for_stream_end(bytes: &mpsc::Receiver<io::Result<Vec<u8>>>, stream: &str) -> Vec<u8> {
    bytes
        .recv_timeout(STEP_WAIT_LIMIT)
        .unwrap_or_else(|error| panic!("the binary's {stream} did not end: {error}"))
        .unwrap_or_else(|error| panic!("the binary's {stream} could not be read: {error}"))
}
