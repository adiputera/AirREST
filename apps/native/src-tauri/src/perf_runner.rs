use crate::perf_histogram::PerfHistogram;
use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method, redirect};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

const MAX_ERROR_SAMPLES: usize = 50;
const MAX_ERROR_SNIPPET_BYTES: usize = 4096;
const MAX_DATA_FILE_ROWS: usize = 50_000;

static GLOBAL_COUNTER: AtomicU64 = AtomicU64::new(1);

struct ActiveRunControl {
    cancel_tx: watch::Sender<bool>,
    shared_vars: Arc<RwLock<Arc<HashMap<String, String>>>>,
}

#[derive(Default)]
pub struct PerfRunnerManager {
    active_runs: Mutex<HashMap<String, ActiveRunControl>>,
}

#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyValuePairInput {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormDataItemInput {
    pub id: String,
    pub key: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfigInput {
    #[serde(rename = "type")]
    pub auth_type: String,
    pub bearer_token: Option<String>,
    pub basic_username: Option<String>,
    pub basic_password: Option<String>,
    pub api_key_key: Option<String>,
    pub api_key_value: Option<String>,
    pub api_key_in: Option<String>,
}

#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestInput {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub params: Vec<KeyValuePairInput>,
    #[serde(default)]
    pub path_variables: Vec<KeyValuePairInput>,
    #[serde(default)]
    pub headers: Vec<KeyValuePairInput>,
    pub auth: AuthConfigInput,
    pub body_type: String,
    pub raw_type: Option<String>,
    #[serde(default)]
    pub body_content: String,
    pub graphql_query: Option<String>,
    pub graphql_variables: Option<String>,
    #[serde(default)]
    pub body_form_data: Vec<FormDataItemInput>,
    #[serde(default)]
    pub body_url_encoded: Vec<KeyValuePairInput>,
}

#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayloadInput {
    pub field_key: Option<String>,
    pub file_name: String,
    pub mime_type: String,
    pub bytes_base64: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequestItemInput {
    pub id: String,
    pub name: String,
    pub path: String,
    pub request: ApiRequestInput,
    pub binary_base64: Option<String>,
    #[serde(default)]
    pub form_attachments: HashMap<String, AttachmentPayloadInput>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StaircaseStepInput {
    pub end_norm: f64,
    pub virtual_users: u32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadProfileConfigInput {
    pub profile: String,
    pub virtual_users: u32,
    pub base_load: u32,
    pub duration_value: u32,
    pub duration_unit: String,
    #[serde(default)]
    pub handles: HashMap<String, Vec<f64>>,
    #[serde(default)]
    pub staircase_steps: Vec<StaircaseStepInput>,
    #[serde(default)]
    pub think_time_ms: u64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOptionsInput {
    pub request_timeout_ms: u64,
    pub follow_redirects: bool,
    pub ignore_ssl_errors: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataFileReadMode {
    Sequential,
    Random,
    PerVu,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NativeDataFileInput {
    pub read_mode: DataFileReadMode,
    #[serde(default)]
    pub rows: Vec<HashMap<String, String>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NativePerfRunInput {
    pub run_id: String,
    pub items: Vec<NativeRequestItemInput>,
    #[serde(default)]
    pub initial_variables: HashMap<String, String>,
    pub load_profile: LoadProfileConfigInput,
    pub network: NetworkOptionsInput,
    #[serde(default)]
    pub data_file: Option<NativeDataFileInput>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CapacityInfo {
    pub soft_fd_limit: Option<u64>,
    pub hard_fd_limit: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResult {
    pub run_id: String,
    pub soft_fd_limit: Option<u64>,
    pub effective_max_vus: u32,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MetricSnapshotOut {
    pub total_requests: u64,
    pub error_count: u64,
    pub error_rate_pct: f64,
    pub requests_per_sec: f64,
    pub max_requests_per_sec: u64,
    pub avg_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub p90_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub bytes_received: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RequestBucketMetricsOut {
    pub total_requests: u64,
    pub error_count: u64,
    pub error_rate_pct: f64,
    pub requests_per_sec: u64,
    pub avg_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub p90_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimeBucketOut {
    pub second: u32,
    pub timestamp_ms: u64,
    pub virtual_users: u32,
    pub total_requests: u64,
    pub error_count: u64,
    pub error_rate_pct: f64,
    pub requests_per_sec: u64,
    pub avg_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub p90_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub by_request: HashMap<String, RequestBucketMetricsOut>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndpointBreakdownOut {
    pub request_id: String,
    pub name: String,
    pub method: String,
    pub path: String,
    pub total_requests: u64,
    pub error_count: u64,
    pub error_rate_pct: f64,
    pub requests_per_sec: f64,
    pub max_requests_per_sec: u64,
    pub avg_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub p90_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub bytes_received: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ErrorGroupOut {
    pub key: String,
    pub status: u16,
    pub category: String,
    pub label: String,
    pub count: u64,
    pub request_ids: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ErrorSampleOut {
    pub id: String,
    pub timestamp_ms: u64,
    pub request_id: String,
    pub request_name: String,
    pub method: String,
    pub url: String,
    pub status: u16,
    pub status_text: String,
    pub category: String,
    pub message: String,
    pub response_snippet: Option<String>,
    pub time_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PerfTickEvent {
    pub run_id: String,
    pub elapsed_ms: u64,
    pub active_vus: u32,
    pub unauthorized_count: u64,
    pub summary: MetricSnapshotOut,
    pub bucket: Option<TimeBucketOut>,
    pub endpoints: Vec<EndpointBreakdownOut>,
    pub error_groups: Vec<ErrorGroupOut>,
    pub error_samples: Vec<ErrorSampleOut>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PerfCompleteEvent {
    pub run_id: String,
    pub status: String,
    pub duration_ms: u64,
    pub failure_reason: Option<String>,
    pub summary: MetricSnapshotOut,
    pub time_series: Vec<TimeBucketOut>,
    pub endpoints: Vec<EndpointBreakdownOut>,
    pub error_groups: Vec<ErrorGroupOut>,
    pub error_samples: Vec<ErrorSampleOut>,
    pub warnings: Vec<String>,
}

struct EndpointAcc {
    id: String,
    name: String,
    method: String,
    path: String,
    hist: PerfHistogram,
    total_requests: u64,
    error_count: u64,
    bytes_received: u64,
}

struct ReqBucketAcc {
    hist: PerfHistogram,
    total_requests: u64,
    error_count: u64,
}

struct SecondBucketAcc {
    second: u32,
    timestamp_ms: u64,
    virtual_users: u32,
    hist: PerfHistogram,
    total_requests: u64,
    error_count: u64,
    by_request: HashMap<String, ReqBucketAcc>,
}

struct ErrorGroupAcc {
    status: u16,
    category: String,
    label: String,
    count: u64,
    request_ids: HashSet<String>,
}

struct PerfRunMetrics {
    run_start_wall_ms: u64,
    duration_sec: u32,
    total_hist: PerfHistogram,
    total_requests: u64,
    error_count: u64,
    unauthorized_count: u64,
    bytes_received: u64,
    endpoints: Vec<EndpointAcc>,
    endpoint_index: HashMap<String, usize>,
    buckets: BTreeMap<u32, SecondBucketAcc>,
    error_groups: HashMap<String, ErrorGroupAcc>,
    error_samples: Vec<ErrorSampleOut>,
}

impl PerfRunMetrics {
    fn new(items: &[NativeRequestItemInput], duration_sec: u32, run_start_wall_ms: u64) -> Self {
        let mut endpoints = Vec::with_capacity(items.len());
        let mut endpoint_index = HashMap::new();
        for (i, it) in items.iter().enumerate() {
            endpoint_index.insert(it.id.clone(), i);
            endpoints.push(EndpointAcc {
                id: it.id.clone(),
                name: it.name.clone(),
                method: it.request.method.to_uppercase(),
                path: it.path.clone(),
                hist: PerfHistogram::new(),
                total_requests: 0,
                error_count: 0,
                bytes_received: 0,
            });
        }
        Self {
            run_start_wall_ms,
            duration_sec,
            total_hist: PerfHistogram::new(),
            total_requests: 0,
            error_count: 0,
            unauthorized_count: 0,
            bytes_received: 0,
            endpoints,
            endpoint_index,
            buckets: BTreeMap::new(),
            error_groups: HashMap::new(),
            error_samples: Vec::new(),
        }
    }

    fn bucket_mut(&mut self, sec: u32) -> &mut SecondBucketAcc {
        let wall = self.run_start_wall_ms + (sec as u64) * 1000;
        self.buckets.entry(sec).or_insert_with(|| SecondBucketAcc {
            second: sec,
            timestamp_ms: wall,
            virtual_users: 0,
            hist: PerfHistogram::new(),
            total_requests: 0,
            error_count: 0,
            by_request: HashMap::new(),
        })
    }

    fn note_active_vus(&mut self, sec: u32, active_vus: u32) {
        let b = self.bucket_mut(sec);
        if active_vus > b.virtual_users {
            b.virtual_users = active_vus;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record(
        &mut self,
        sec: u32,
        request_id: &str,
        request_name: &str,
        method: &str,
        url: &str,
        time_ms: u64,
        bytes: u64,
        status: u16,
        status_text: &str,
        is_error: bool,
        err_category: &str,
        err_msg: &str,
        err_snippet: Option<String>,
    ) {
        let clamped_sec = sec.min(self.duration_sec.saturating_sub(1));
        self.total_requests += 1;
        if is_error {
            self.error_count += 1;
        }
        if status == 401 {
            self.unauthorized_count += 1;
        }
        self.bytes_received += bytes;
        self.total_hist.record(time_ms);

        if let Some(&idx) = self.endpoint_index.get(request_id) {
            let ep = &mut self.endpoints[idx];
            ep.total_requests += 1;
            if is_error {
                ep.error_count += 1;
            }
            ep.bytes_received += bytes;
            ep.hist.record(time_ms);
        }

        {
            let b = self.bucket_mut(clamped_sec);
            b.total_requests += 1;
            if is_error {
                b.error_count += 1;
            }
            b.hist.record(time_ms);
            let rb = b
                .by_request
                .entry(request_id.to_string())
                .or_insert_with(|| ReqBucketAcc {
                    hist: PerfHistogram::new(),
                    total_requests: 0,
                    error_count: 0,
                });
            rb.total_requests += 1;
            if is_error {
                rb.error_count += 1;
            }
            rb.hist.record(time_ms);
        }

        if is_error {
            let key = format!("{}:{}", status, err_category);
            let grp = self.error_groups.entry(key).or_insert_with(|| ErrorGroupAcc {
                status,
                category: err_category.to_string(),
                label: if status > 0 {
                    format!("HTTP {} {}", status, status_text).trim().to_string()
                } else {
                    status_text.to_string()
                },
                count: 0,
                request_ids: HashSet::new(),
            });
            grp.count += 1;
            grp.request_ids.insert(request_id.to_string());

            if self.error_samples.len() < MAX_ERROR_SAMPLES {
                let sample_id = format!(
                    "err_{}_{}",
                    self.error_samples.len() + 1,
                    GLOBAL_COUNTER.fetch_add(1, Ordering::Relaxed)
                );
                self.error_samples.push(ErrorSampleOut {
                    id: sample_id,
                    timestamp_ms: now_wall_ms(),
                    request_id: request_id.to_string(),
                    request_name: request_name.to_string(),
                    method: method.to_string(),
                    url: url.to_string(),
                    status,
                    status_text: status_text.to_string(),
                    category: err_category.to_string(),
                    message: err_msg.to_string(),
                    response_snippet: err_snippet,
                    time_ms,
                });
            }
        }
    }

    fn snapshot_summary(&self, elapsed_sec: f64) -> MetricSnapshotOut {
        let safe_sec = elapsed_sec.max(0.001);
        let h = self.total_hist.summary();
        let err_pct = if self.total_requests > 0 {
            ((self.error_count as f64 / self.total_requests as f64) * 10000.0).round() / 100.0
        } else {
            0.0
        };
        let rps = ((self.total_requests as f64 / safe_sec) * 100.0).round() / 100.0;
        let max_rps = self
            .buckets
            .values()
            .map(|b| b.total_requests)
            .max()
            .unwrap_or(0);
        MetricSnapshotOut {
            total_requests: self.total_requests,
            error_count: self.error_count,
            error_rate_pct: err_pct,
            requests_per_sec: rps,
            max_requests_per_sec: max_rps,
            avg_ms: h.avg_ms,
            min_ms: h.min_ms,
            max_ms: h.max_ms,
            p90_ms: h.p90_ms,
            p95_ms: h.p95_ms,
            p99_ms: h.p99_ms,
            bytes_received: self.bytes_received,
        }
    }

    fn export_bucket(b: &SecondBucketAcc) -> TimeBucketOut {
        let h = b.hist.summary();
        let mut by_req = HashMap::with_capacity(b.by_request.len());
        for (req_id, rb) in &b.by_request {
            let rh = rb.hist.summary();
            let err_pct = if rb.total_requests > 0 {
                ((rb.error_count as f64 / rb.total_requests as f64) * 10000.0).round() / 100.0
            } else {
                0.0
            };
            by_req.insert(
                req_id.clone(),
                RequestBucketMetricsOut {
                    total_requests: rb.total_requests,
                    error_count: rb.error_count,
                    error_rate_pct: err_pct,
                    requests_per_sec: rb.total_requests,
                    avg_ms: rh.avg_ms,
                    min_ms: rh.min_ms,
                    max_ms: rh.max_ms,
                    p90_ms: rh.p90_ms,
                    p95_ms: rh.p95_ms,
                    p99_ms: rh.p99_ms,
                },
            );
        }
        let err_pct = if b.total_requests > 0 {
            ((b.error_count as f64 / b.total_requests as f64) * 10000.0).round() / 100.0
        } else {
            0.0
        };
        TimeBucketOut {
            second: b.second,
            timestamp_ms: b.timestamp_ms,
            virtual_users: b.virtual_users,
            total_requests: b.total_requests,
            error_count: b.error_count,
            error_rate_pct: err_pct,
            requests_per_sec: b.total_requests,
            avg_ms: h.avg_ms,
            min_ms: h.min_ms,
            max_ms: h.max_ms,
            p90_ms: h.p90_ms,
            p95_ms: h.p95_ms,
            p99_ms: h.p99_ms,
            by_request: by_req,
        }
    }

    fn export_endpoints(&self, elapsed_sec: f64) -> Vec<EndpointBreakdownOut> {
        let safe_sec = elapsed_sec.max(0.001);
        self.endpoints
            .iter()
            .map(|ep| {
                let h = ep.hist.summary();
                let err_pct = if ep.total_requests > 0 {
                    ((ep.error_count as f64 / ep.total_requests as f64) * 10000.0).round() / 100.0
                } else {
                    0.0
                };
                let rps = ((ep.total_requests as f64 / safe_sec) * 100.0).round() / 100.0;
                let max_rps = self
                    .buckets
                    .values()
                    .map(|b| b.by_request.get(&ep.id).map(|rb| rb.total_requests).unwrap_or(0))
                    .max()
                    .unwrap_or(0);
                EndpointBreakdownOut {
                    request_id: ep.id.clone(),
                    name: ep.name.clone(),
                    method: ep.method.clone(),
                    path: ep.path.clone(),
                    total_requests: ep.total_requests,
                    error_count: ep.error_count,
                    error_rate_pct: err_pct,
                    requests_per_sec: rps,
                    max_requests_per_sec: max_rps,
                    avg_ms: h.avg_ms,
                    min_ms: h.min_ms,
                    max_ms: h.max_ms,
                    p90_ms: h.p90_ms,
                    p95_ms: h.p95_ms,
                    p99_ms: h.p99_ms,
                    bytes_received: ep.bytes_received,
                }
            })
            .collect()
    }

    fn export_error_groups(&self) -> Vec<ErrorGroupOut> {
        let mut out: Vec<ErrorGroupOut> = self
            .error_groups
            .iter()
            .map(|(k, g)| ErrorGroupOut {
                key: k.clone(),
                status: g.status,
                category: g.category.clone(),
                label: g.label.clone(),
                count: g.count,
                request_ids: g.request_ids.iter().cloned().collect(),
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count));
        out
    }
}

fn now_wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pseudo_random_u64() -> u64 {
    let mut x = now_wall_ms()
        ^ GLOBAL_COUNTER
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    x.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

fn pseudo_uuid_v4() -> String {
    let a = pseudo_random_u64();
    let b = pseudo_random_u64();
    let bytes: [u8; 16] = [
        (a >> 56) as u8,
        (a >> 48) as u8,
        (a >> 40) as u8,
        (a >> 32) as u8,
        (a >> 24) as u8,
        (a >> 16) as u8,
        (((a >> 8) as u8) & 0x0f) | 0x40,
        a as u8,
        (((b >> 56) as u8) & 0x3f) | 0x80,
        (b >> 48) as u8,
        (b >> 40) as u8,
        (b >> 32) as u8,
        (b >> 24) as u8,
        (b >> 16) as u8,
        (b >> 8) as u8,
        b as u8,
    ];
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn iso_timestamp_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil date conversion from Unix epoch seconds (Howard Hinnant algorithm)
    let z = (secs / 86400) as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = y + if m <= 2 { 1 } else { 0 };
    let rem = secs % 86400;
    let hr = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        yr, m, d, hr, min, sec
    )
}

pub fn interpolate_variables(input: &str, vars: &HashMap<String, String>) -> String {
    if input.is_empty() || !input.contains("{{") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        if let Some(end) = after_open.find("}}") {
            let token = &after_open[..end];
            if token.contains('{') || token.contains('}') {
                out.push_str("{{");
                rest = after_open;
                continue;
            }
            let key = token.trim();
            match key {
                "$guid" => out.push_str(&pseudo_uuid_v4()),
                "$timestamp" => {
                    let s = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    out.push_str(&s.to_string());
                }
                "$isoTimestamp" => out.push_str(&iso_timestamp_utc()),
                "$randomInt" => {
                    let v = (pseudo_random_u64() % 1000) + 1;
                    out.push_str(&v.to_string());
                }
                _ => {
                    if let Some(val) = vars.get(key) {
                        out.push_str(val);
                    } else {
                        out.push_str("{{");
                        out.push_str(token);
                        out.push_str("}}");
                    }
                }
            }
            rest = &after_open[end + 2..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn strip_json_comments(input: &str) -> String {
    if !input.contains("//") && !input.contains("/*") {
        return input.to_string();
    }
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_string = false;
    let mut quote = '"';
    let mut escaped = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while i < len {
        let ch = chars[i];
        let next = if i + 1 < len { Some(chars[i + 1]) } else { None };
        if in_line_comment {
            if ch == '\n' || ch == '\r' {
                in_line_comment = false;
                out.push(ch);
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            if ch == '*' && next == Some('/') {
                in_block_comment = false;
                i += 2;
            } else {
                if ch == '\n' || ch == '\r' {
                    out.push(ch);
                }
                i += 1;
            }
            continue;
        }
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            in_string = true;
            quote = ch;
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == '/' && next == Some('/') {
            in_line_comment = true;
            i += 2;
            continue;
        }
        if ch == '/' && next == Some('*') {
            in_block_comment = true;
            i += 2;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn substitute_path_vars(raw_url: &str, path_vars: &[KeyValuePairInput], vars: &HashMap<String, String>) -> String {
    if path_vars.is_empty() {
        return raw_url.to_string();
    }
    let mut result = raw_url.to_string();
    for pv in path_vars {
        if !pv.enabled {
            continue;
        }
        let key = pv.key.trim();
        if key.is_empty() {
            continue;
        }
        let val = interpolate_variables(&pv.value, vars);
        let pattern = format!(":{}", key);
        let mut rebuilt = String::with_capacity(result.len());
        let mut idx = 0;
        while let Some(pos) = result[idx..].find(&pattern) {
            let abs = idx + pos;
            let before_ok = abs == 0 || result.as_bytes()[abs - 1] == b'/';
            let after_idx = abs + pattern.len();
            let after_ok = after_idx >= result.len()
                || matches!(result.as_bytes()[after_idx], b'/' | b'?' | b'#');
            if before_ok && after_ok {
                rebuilt.push_str(&result[idx..abs]);
                rebuilt.push_str(&val);
                idx = after_idx;
            } else {
                rebuilt.push_str(&result[idx..abs + 1]);
                idx = abs + 1;
            }
        }
        rebuilt.push_str(&result[idx..]);
        result = rebuilt;
    }
    result
}

pub fn get_duration_seconds(profile: &LoadProfileConfigInput) -> u32 {
    let raw = profile.duration_value.max(1);
    if profile.duration_unit == "minutes" {
        (raw.saturating_mul(60)).min(3600)
    } else {
        raw.clamp(5, 3600)
    }
}

pub fn get_target_vus_at_time(profile: &LoadProfileConfigInput, elapsed_sec: f64) -> u32 {
    let duration_sec = get_duration_seconds(profile) as f64;
    let norm = (elapsed_sec.clamp(0.0, duration_sec)) / duration_sec.max(1.0);
    let peak_u32 = profile.virtual_users.max(1);
    let peak = peak_u32 as f64;
    let base = (profile.base_load as f64).min((peak - 1.0).max(0.0));

    if profile.profile == "staircase" && !profile.staircase_steps.is_empty() {
        const MIN_STEP_SEC: f64 = 5.0;
        const MAX_STEPS: usize = 12;
        let safe_dur = duration_sec.max(MIN_STEP_SEC);
        let max_steps = ((safe_dur / MIN_STEP_SEC).floor() as usize).clamp(1, MAX_STEPS);
        let target_count = profile.staircase_steps.len().clamp(1, max_steps);
        let min_step_gap = (MIN_STEP_SEC / safe_dur).min(1.0);

        let mut normalized: Vec<(f64, u32)> = profile
            .staircase_steps
            .iter()
            .take(target_count)
            .enumerate()
            .map(|(idx, step)| {
                let end = if step.end_norm.is_finite() {
                    step.end_norm
                } else {
                    (idx + 1) as f64 / target_count as f64
                };
                (end, step.virtual_users.min(peak_u32))
            })
            .collect();

        if normalized.len() == 1 {
            return normalized[0].1;
        }
        let len = normalized.len();
        for i in 0..(len - 1) {
            let prev = if i == 0 { 0.0 } else { normalized[i - 1].0 };
            let min_bound = prev + min_step_gap;
            let max_bound = (1.0 - ((len - 1 - i) as f64) * min_step_gap).max(min_bound);
            normalized[i].0 = normalized[i].0.clamp(min_bound, max_bound);
        }
        normalized[len - 1].0 = 1.0;

        for (end_norm, vus) in &normalized {
            if norm <= *end_norm + 1e-9 {
                return *vus;
            }
        }
        return normalized.last().map(|s| s.1).unwrap_or(peak_u32);
    }

    let min_gap = (1.0 / duration_sec.max(1.0)).clamp(0.02, 0.08);

    let default_handles: Vec<f64> = match profile.profile.as_str() {
        "ramp_up" => vec![0.3],
        "spike" => vec![0.45, 0.5, 0.7833],
        "peak" => vec![0.25, 0.35, 0.7, 0.82],
        "staircase" => vec![0.25, 0.5, 0.75],
        _ => vec![],
    };

    let mut handles = match profile.handles.get(&profile.profile) {
        Some(h) if h.len() == default_handles.len() => h.clone(),
        _ => default_handles.clone(),
    };
    for i in 0..handles.len() {
        let min_b = if i == 0 { min_gap } else { handles[i - 1] + min_gap };
        let max_b = 1.0 - ((handles.len() - i) as f64) * min_gap;
        handles[i] = handles[i].clamp(min_b, max_b);
    }

    let pts: Vec<(f64, f64)> = match profile.profile.as_str() {
        "ramp_up" => vec![(0.0, base), (handles[0], peak), (1.0, peak)],
        "spike" => vec![
            (0.0, base),
            (handles[0], base),
            (handles[1], peak),
            (handles[2], base),
            (1.0, base),
        ],
        "peak" => vec![
            (0.0, base),
            (handles[0], base),
            (handles[1], peak),
            (handles[2], peak),
            (handles[3], base),
            (1.0, base),
        ],
        "staircase" => {
            let s1 = (base + (peak - base) * 0.33).round().max(base + 1.0).min(peak);
            let s2 = (base + (peak - base) * 0.66).round().max(s1).min(peak);
            vec![
                (0.0, s1),
                (handles[0], s1),
                (handles[0], s2),
                (handles[1], s2),
                (handles[1], peak),
                (handles[2], peak),
                (handles[2], base),
                (1.0, base),
            ]
        }
        _ => vec![(0.0, peak), (1.0, peak)],
    };

    if norm <= pts[0].0 {
        return pts[0].1.round().max(0.0) as u32;
    }
    for i in 1..pts.len() {
        let (x0, y0) = pts[i - 1];
        let (x1, y1) = pts[i];
        if norm <= x1 {
            let span = x1 - x0;
            if span <= 1e-9 {
                continue;
            }
            let t = (norm - x0) / span;
            return (y0 + (y1 - y0) * t).round().max(0.0) as u32;
        }
    }
    pts.last().map(|p| p.1.round().max(0.0) as u32).unwrap_or(1)
}

#[derive(Clone)]
struct DecodedAttachments {
    binary: Option<Vec<u8>>,
    form_files: HashMap<String, (String, String, Vec<u8>)>,
}

fn decode_item_attachments(item: &NativeRequestItemInput) -> Result<DecodedAttachments, String> {
    let binary = match &item.binary_base64 {
        Some(b64) if !b64.is_empty() => Some(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("Invalid binary attachment for {}: {}", item.name, e))?,
        ),
        _ => None,
    };

    let mut form_files = HashMap::new();
    for (id, payload) in &item.form_attachments {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&payload.bytes_base64)
            .map_err(|e| format!("Invalid form attachment for {}: {}", item.name, e))?;
        form_files.insert(
            id.clone(),
            (payload.file_name.clone(), payload.mime_type.clone(), bytes),
        );
    }

    Ok(DecodedAttachments { binary, form_files })
}

fn prepare_reqwest(
    client: &Client,
    item: &NativeRequestItemInput,
    attachments: &DecodedAttachments,
    vars: &HashMap<String, String>,
) -> Result<(reqwest::RequestBuilder, String), String> {
    let req = &item.request;
    let mut raw_url = interpolate_variables(req.url.trim(), vars);
    raw_url = substitute_path_vars(&raw_url, &req.path_variables, vars);

    let has_scheme = raw_url
        .split_once("://")
        .map(|(s, _)| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)))
        .unwrap_or(false);
    if !has_scheme {
        let lower = raw_url.to_ascii_lowercase();
        let is_local = lower.starts_with("localhost")
            || lower.starts_with("127.")
            || lower.starts_with("10.")
            || lower.starts_with("192.168.")
            || (lower.starts_with("172.")
                && lower[4..]
                    .split('.')
                    .next()
                    .and_then(|oct| oct.parse::<u8>().ok())
                    .map(|n| (16..=31).contains(&n))
                    .unwrap_or(false));
        raw_url = if is_local {
            format!("http://{}", raw_url)
        } else {
            format!("https://{}", raw_url)
        };
    }

    let mut parsed_url = url::Url::parse(&raw_url).map_err(|e| format!("Invalid URL \"{}\": {}", raw_url, e))?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err(format!("Unsupported protocol: {}", parsed_url.scheme()));
    }

    // Apply query params (clearing existing param keys managed by params array)
    if !req.params.is_empty() {
        let mut cleared = HashSet::new();
        let mut existing_pairs: Vec<(String, String)> = parsed_url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();

        for p in &req.params {
            let p_key = interpolate_variables(p.key.trim(), vars);
            if p_key.is_empty() {
                continue;
            }
            if cleared.insert(p_key.clone()) {
                existing_pairs.retain(|(k, _)| k != &p_key);
            }
            if p.enabled {
                let p_val = interpolate_variables(&p.value, vars);
                existing_pairs.push((p_key, p_val));
            }
        }
        if existing_pairs.is_empty() {
            parsed_url.set_query(None);
        } else {
            let mut pairs_mut = parsed_url.query_pairs_mut();
            pairs_mut.clear();
            for (k, v) in existing_pairs {
                pairs_mut.append_pair(&k, &v);
            }
        }
    }

    // Resolve Auth
    let mut auth_header: Option<(String, String)> = None;
    match req.auth.auth_type.as_str() {
        "bearer" => {
            if let Some(tok) = &req.auth.bearer_token {
                let resolved = interpolate_variables(tok.trim(), vars);
                if !resolved.is_empty() {
                    auth_header = Some(("Authorization".to_string(), format!("Bearer {}", resolved)));
                }
            }
        }
        "basic" => {
            let u = interpolate_variables(req.auth.basic_username.as_deref().unwrap_or(""), vars);
            let p = interpolate_variables(req.auth.basic_password.as_deref().unwrap_or(""), vars);
            if !u.is_empty() || !p.is_empty() {
                let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", u, p));
                auth_header = Some(("Authorization".to_string(), format!("Basic {}", encoded)));
            }
        }
        "apikey" => {
            let key = interpolate_variables(req.auth.api_key_key.as_deref().unwrap_or("").trim(), vars);
            let val = interpolate_variables(req.auth.api_key_value.as_deref().unwrap_or("").trim(), vars);
            if !key.trim().is_empty() && !val.is_empty() {
                if req.auth.api_key_in.as_deref() == Some("query") {
                    let mut pairs: Vec<(String, String)> = parsed_url
                        .query_pairs()
                        .filter(|(k, _)| k != key.trim())
                        .map(|(k, v)| (k.into_owned(), v.into_owned()))
                        .collect();
                    pairs.push((key.trim().to_string(), val));
                    let mut pairs_mut = parsed_url.query_pairs_mut();
                    pairs_mut.clear();
                    for (k, v) in pairs {
                        pairs_mut.append_pair(&k, &v);
                    }
                } else {
                    auth_header = Some((key.trim().to_string(), val));
                }
            }
        }
        _ => {}
    }

    let final_url = parsed_url.to_string();
    let method = Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|_| format!("Invalid HTTP method: {}", req.method))?;

    let body_managed_ct = req.method.to_uppercase() != "GET"
        && req.method.to_uppercase() != "HEAD"
        && req.body_type != "none";
    let auth_key_lower = auth_header.as_ref().map(|(k, _)| k.to_ascii_lowercase());

    let mut headers = HeaderMap::new();
    let mut cookie_parts: Vec<String> = Vec::new();
    let mut has_content_type = false;

    for h in &req.headers {
        if !h.enabled {
            continue;
        }
        let k = interpolate_variables(h.key.trim(), vars);
        let k_trim = k.trim();
        if k_trim.is_empty() {
            continue;
        }
        let k_lower = k_trim.to_ascii_lowercase();
        if auth_key_lower.as_deref() == Some(k_lower.as_str()) {
            continue;
        }
        if body_managed_ct && k_lower == "content-type" && req.body_type == "form-data" {
            continue;
        }
        let v = interpolate_variables(&h.value, vars);
        if k_lower == "cookie" {
            if !v.is_empty() {
                cookie_parts.push(v);
            }
            continue;
        }
        if k_lower == "content-type" {
            has_content_type = true;
        }
        if let (Ok(hn), Ok(hv)) = (
            HeaderName::from_bytes(k_trim.as_bytes()),
            HeaderValue::from_str(&v),
        ) {
            headers.insert(hn, hv);
        }
    }

    if !cookie_parts.is_empty() {
        if let Ok(hv) = HeaderValue::from_str(&cookie_parts.join("; ")) {
            headers.insert(HeaderName::from_static("cookie"), hv);
        }
    }

    if let Some((ak, av)) = auth_header {
        if let (Ok(hn), Ok(hv)) = (
            HeaderName::from_bytes(ak.as_bytes()),
            HeaderValue::from_str(&av),
        ) {
            headers.insert(hn, hv);
        }
    }

    let mut builder = client.request(method.clone(), &final_url);

    if method != Method::GET && method != Method::HEAD {
        let body_type = req.body_type.as_str();
        let raw_type = req.raw_type.as_deref().unwrap_or("text");
        if body_type == "json" || (body_type == "raw" && raw_type == "json") {
            if !has_content_type {
                headers.insert(
                    HeaderName::from_static("content-type"),
                    HeaderValue::from_static("application/json"),
                );
            }
            let payload = strip_json_comments(&interpolate_variables(&req.body_content, vars));
            builder = builder.body(payload);
        } else if body_type == "graphql" {
            if !has_content_type {
                headers.insert(
                    HeaderName::from_static("content-type"),
                    HeaderValue::from_static("application/json"),
                );
            }
            let q = interpolate_variables(
                req.graphql_query.as_deref().unwrap_or(&req.body_content),
                vars,
            );
            let raw_v = strip_json_comments(&interpolate_variables(
                req.graphql_variables.as_deref().unwrap_or(""),
                vars,
            ));
            let mut obj = serde_json::Map::new();
            obj.insert("query".to_string(), serde_json::Value::String(q));
            if let Ok(parsed_v) = serde_json::from_str::<serde_json::Value>(raw_v.trim()) {
                obj.insert("variables".to_string(), parsed_v);
            }
            builder = builder.body(serde_json::Value::Object(obj).to_string());
        } else if body_type == "xml" || (body_type == "raw" && raw_type == "xml") {
            if !has_content_type {
                headers.insert(
                    HeaderName::from_static("content-type"),
                    HeaderValue::from_static("application/xml"),
                );
            }
            builder = builder.body(interpolate_variables(&req.body_content, vars));
        } else if body_type == "raw" && raw_type == "html" {
            if !has_content_type {
                headers.insert(
                    HeaderName::from_static("content-type"),
                    HeaderValue::from_static("text/html"),
                );
            }
            builder = builder.body(interpolate_variables(&req.body_content, vars));
        } else if body_type == "raw" {
            if !has_content_type {
                headers.insert(
                    HeaderName::from_static("content-type"),
                    HeaderValue::from_static("text/plain"),
                );
            }
            builder = builder.body(interpolate_variables(&req.body_content, vars));
        } else if body_type == "x-www-form-urlencoded" {
            if !has_content_type {
                headers.insert(
                    HeaderName::from_static("content-type"),
                    HeaderValue::from_static("application/x-www-form-urlencoded"),
                );
            }
            let active: Vec<(String, String)> = req
                .body_url_encoded
                .iter()
                .filter(|it| it.enabled && !it.key.trim().is_empty())
                .map(|it| {
                    (
                        interpolate_variables(it.key.trim(), vars),
                        interpolate_variables(&it.value, vars),
                    )
                })
                .collect();
            if !active.is_empty() {
                builder = builder.form(&active);
            } else {
                builder = builder.body(interpolate_variables(&req.body_content, vars));
            }
        } else if body_type == "form-data" {
            let mut form = reqwest::multipart::Form::new();
            for f in &req.body_form_data {
                if !f.enabled || f.key.trim().is_empty() {
                    continue;
                }
                let k = interpolate_variables(f.key.trim(), vars);
                if f.item_type == "file" {
                    if let Some((fname, mime, bytes)) = attachments.form_files.get(&f.id) {
                        let part = reqwest::multipart::Part::bytes(bytes.clone())
                            .file_name(fname.clone())
                            .mime_str(mime)
                            .unwrap_or_else(|_| reqwest::multipart::Part::bytes(bytes.clone()));
                        form = form.part(k, part);
                    }
                } else {
                    form = form.text(k, interpolate_variables(&f.value, vars));
                }
            }
            builder = builder.multipart(form);
        } else if body_type == "binary" {
            if let Some(bytes) = &attachments.binary {
                if !has_content_type {
                    headers.insert(
                        HeaderName::from_static("content-type"),
                        HeaderValue::from_static("application/octet-stream"),
                    );
                }
                builder = builder.body(bytes.clone());
            }
        }
    }

    Ok((builder.headers(headers), final_url))
}

fn classify_reqwest_error(err: &reqwest::Error) -> (&'static str, &'static str) {
    if err.is_timeout() {
        ("timeout", "Request Timed Out")
    } else if err.is_connect() {
        let msg = err.to_string().to_ascii_uppercase();
        if msg.contains("DNS") || msg.contains("RESOLVE") || msg.contains("NO SUCH HOST") {
            ("dns", "Network Error (DNS)")
        } else if msg.contains("CERT") || msg.contains("TLS") || msg.contains("SSL") {
            ("ssl", "Network Error (SSL)")
        } else {
            ("connection_refused", "Network Error (Connection)")
        }
    } else {
        ("other", "Network Error")
    }
}

#[cfg(unix)]
fn check_and_boost_fd_limit(target_fds: u64) -> (Option<u64>, Option<u64>) {
    unsafe {
        let mut rlim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) != 0 {
            return (None, None);
        }
        let hard = rlim.rlim_max as u64;
        let desired = target_fds.min(hard);
        if (rlim.rlim_cur as u64) < desired {
            rlim.rlim_cur = desired as libc::rlim_t;
            let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &rlim);
            let _ = libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim);
        }
        (Some(rlim.rlim_cur as u64), Some(hard))
    }
}

#[cfg(not(unix))]
fn check_and_boost_fd_limit(_target_fds: u64) -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[tauri::command]
pub fn check_performance_capacity() -> CapacityInfo {
    let (soft, hard) = check_and_boost_fd_limit(32_768);
    CapacityInfo {
        soft_fd_limit: soft,
        hard_fd_limit: hard,
    }
}

#[tauri::command]
pub async fn stop_performance_run(
    run_id: String,
    manager: State<'_, PerfRunnerManager>,
) -> Result<(), String> {
    if let Ok(guard) = manager.active_runs.lock() {
        if let Some(ctrl) = guard.get(&run_id) {
            let _ = ctrl.cancel_tx.send(true);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_performance_variables(
    run_id: String,
    variables: HashMap<String, String>,
    manager: State<'_, PerfRunnerManager>,
) -> Result<(), String> {
    let target_vars = if let Ok(guard) = manager.active_runs.lock() {
        guard.get(&run_id).map(|ctrl| ctrl.shared_vars.clone())
    } else {
        None
    };

    if let Some(shared_vars) = target_vars {
        let mut write_guard = shared_vars
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *write_guard = Arc::new(variables);
    }
    Ok(())
}

fn select_data_row_index(
    read_mode: &DataFileReadMode,
    row_count: usize,
    vu_index: usize,
    peak_vus: usize,
    vu_iteration: usize,
    seq_counter: &AtomicUsize,
) -> usize {
    if row_count == 0 {
        return 0;
    }
    match read_mode {
        DataFileReadMode::Random => (pseudo_random_u64() as usize) % row_count,
        DataFileReadMode::PerVu => {
            let safe_peak = peak_vus.max(1);
            let safe_vu = vu_index % safe_peak;
            if row_count >= safe_peak {
                let start = (safe_vu * row_count) / safe_peak;
                let end = ((safe_vu + 1) * row_count) / safe_peak;
                let span = end.saturating_sub(start).max(1);
                start + (vu_iteration % span)
            } else {
                safe_vu % row_count
            }
        }
        DataFileReadMode::Sequential => seq_counter.fetch_add(1, Ordering::Relaxed) % row_count,
    }
}

fn merge_vars_with_data_row<'a>(
    base_vars: &'a HashMap<String, String>,
    row_vars: Option<&HashMap<String, String>>,
) -> std::borrow::Cow<'a, HashMap<String, String>> {
    match row_vars {
        Some(row) if !row.is_empty() => {
            let mut merged = base_vars.clone();
            for (k, v) in row {
                merged.insert(k.clone(), v.clone());
            }
            std::borrow::Cow::Owned(merged)
        }
        _ => std::borrow::Cow::Borrowed(base_vars),
    }
}

#[tauri::command]
pub async fn start_performance_run(
    app: AppHandle,
    input: NativePerfRunInput,
    manager: State<'_, PerfRunnerManager>,
) -> Result<StartRunResult, String> {
    if input.items.is_empty() {
        return Err("No requests selected for performance run.".to_string());
    }
    if let Some(df) = &input.data_file {
        if df.rows.len() > MAX_DATA_FILE_ROWS {
            return Err(format!(
                "Data file row count ({}) exceeds the native maximum limit of {} rows.",
                df.rows.len(),
                MAX_DATA_FILE_ROWS
            ));
        }
    }

    let peak_vus = input.load_profile.virtual_users.clamp(1, 10_000);
    let (soft_fd, _hard_fd) = check_and_boost_fd_limit(((peak_vus as u64) * 2).max(4096));
    let mut warnings: Vec<String> = Vec::new();
    let mut effective_max_vus = peak_vus;

    if let Some(soft) = soft_fd {
        if (peak_vus as u64) * 2 > soft {
            let safe_cap = (soft / 2).max(1) as u32;
            warnings.push(format!(
                "OS file descriptor soft limit ({}) may constrain {} VUs (recommended headroom ~{} VUs). Consider raising `ulimit -n` if sockets exhaust.",
                soft, peak_vus, safe_cap
            ));
            effective_max_vus = safe_cap.min(peak_vus);
        }
    }

    let decoded_items: Vec<(NativeRequestItemInput, DecodedAttachments)> = input
        .items
        .iter()
        .map(|it| decode_item_attachments(it).map(|att| (it.clone(), att)))
        .collect::<Result<Vec<_>, _>>()?;

    let duration_sec = get_duration_seconds(&input.load_profile);
    let max_allowed_timeout_ms = (u64::from(duration_sec).saturating_mul(1000)).clamp(500, 300_000);
    let requested_timeout = if input.network.request_timeout_ms > 0 {
        input.network.request_timeout_ms
    } else {
        max_allowed_timeout_ms.min(60_000)
    };
    let timeout_ms = requested_timeout.clamp(500, max_allowed_timeout_ms);
    let mut client_builder = Client::builder()
        .pool_max_idle_per_host(peak_vus as usize)
        .pool_idle_timeout(Duration::from_secs(30))
        .tcp_nodelay(true)
        .timeout(Duration::from_millis(timeout_ms))
        .connect_timeout(Duration::from_millis(timeout_ms.min(15_000)));

    if !input.network.follow_redirects {
        client_builder = client_builder.redirect(redirect::Policy::none());
    }
    if input.network.ignore_ssl_errors {
        client_builder = client_builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }

    let client = client_builder
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client pool: {}", e))?;

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let shared_vars: Arc<RwLock<Arc<HashMap<String, String>>>> =
        Arc::new(RwLock::new(Arc::new(input.initial_variables.clone())));
    {
        let mut guard = manager
            .active_runs
            .lock()
            .map_err(|_| "Performance runner lock poisoned.".to_string())?;
        guard.insert(
            input.run_id.clone(),
            ActiveRunControl {
                cancel_tx,
                shared_vars: shared_vars.clone(),
            },
        );
    }

    let run_id = input.run_id.clone();
    let run_start_wall_ms = now_wall_ms();
    let metrics = Arc::new(Mutex::new(PerfRunMetrics::new(
        &input.items,
        duration_sec,
        run_start_wall_ms,
    )));
    let items_arc = Arc::new(decoded_items);
    let data_mode = input
        .data_file
        .as_ref()
        .map(|d| d.read_mode.clone())
        .unwrap_or(DataFileReadMode::Sequential);
    let data_rows_arc: Option<Arc<Vec<HashMap<String, String>>>> = input.data_file.and_then(|d| {
        if d.rows.is_empty() {
            None
        } else {
            Some(Arc::new(d.rows))
        }
    });
    let seq_row_counter = Arc::new(AtomicUsize::new(0));
    let peak_vus_usize = (peak_vus as usize).max(1);
    let profile = input.load_profile.clone();
    let run_warnings = warnings.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let run_start = Instant::now();
        let deadline = run_start + Duration::from_secs(duration_sec as u64);
        let mut active_vu_txs: Vec<watch::Sender<bool>> = Vec::new();
        let mut vu_handles = Vec::new();
        let mut last_tick_sec: i64 = -1;
        let mut next_vu_index: usize = 0;
        let mut scheduler_interval = tokio::time::interval(Duration::from_millis(250));
        let mut cancel_watch = cancel_rx.clone();

        loop {
            tokio::select! {
                _ = scheduler_interval.tick() => {}
                _ = cancel_watch.changed() => {
                    if *cancel_watch.borrow() {
                        break;
                    }
                }
            }

            if *cancel_rx.borrow() || Instant::now() >= deadline {
                break;
            }

            let elapsed = run_start.elapsed();
            let elapsed_sec = elapsed.as_secs_f64();
            let target_vus = get_target_vus_at_time(&profile, elapsed_sec).min(10_000);

            while (active_vu_txs.len() as u32) < target_vus {
                let (vu_tx, mut vu_rx) = watch::channel(false);
                active_vu_txs.push(vu_tx);

                let c = client.clone();
                let its = items_arc.clone();
                let sv = shared_vars.clone();
                let d_rows = data_rows_arc.clone();
                let d_mode = data_mode.clone();
                let d_seq = seq_row_counter.clone();
                let vu_idx = next_vu_index;
                next_vu_index += 1;
                let m = metrics.clone();
                let think_ms = profile.think_time_ms;

                let handle = tauri::async_runtime::spawn(async move {
                    let mut vu_iteration: usize = 0;
                    loop {
                        if *vu_rx.borrow() || Instant::now() >= deadline {
                            break;
                        }
                        let base_snapshot = {
                            let guard = sv
                                .read()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            Arc::clone(&*guard)
                        };
                        let row_opt = d_rows.as_ref().and_then(|rows| {
                            if rows.is_empty() {
                                None
                            } else {
                                let row_idx = select_data_row_index(
                                    &d_mode,
                                    rows.len(),
                                    vu_idx,
                                    peak_vus_usize,
                                    vu_iteration,
                                    &d_seq,
                                );
                                rows.get(row_idx)
                            }
                        });
                        vu_iteration = vu_iteration.wrapping_add(1);
                        let iter_vars = merge_vars_with_data_row(&base_snapshot, row_opt);

                        for (item, att) in its.iter() {
                            if *vu_rx.borrow() || Instant::now() >= deadline {
                                break;
                            }
                            let req_start = Instant::now();
                            let built = prepare_reqwest(&c, item, att, iter_vars.as_ref());
                            match built {
                                Err(err_msg) => {
                                    let t_ms = req_start.elapsed().as_millis() as u64;
                                    let sec = run_start.elapsed().as_secs() as u32;
                                    if let Ok(mut guard) = m.lock() {
                                        guard.record(
                                            sec,
                                            &item.id,
                                            &item.name,
                                            &item.request.method,
                                            &item.request.url,
                                            t_ms,
                                            0,
                                            0,
                                            "Invalid URL",
                                            true,
                                            "invalid_url",
                                            &err_msg,
                                            None,
                                        );
                                    }
                                }
                                Ok((req_builder, final_url)) => {
                                    let send_fut = async {
                                        let mut resp = req_builder.send().await?;
                                        let status = resp.status();
                                        let is_err = !status.is_success();
                                        let mut bytes_received: u64 = 0;
                                        let mut snippet_buf: Vec<u8> = Vec::new();
                                        while let Some(chunk) = resp.chunk().await? {
                                            bytes_received += chunk.len() as u64;
                                            if is_err && snippet_buf.len() < MAX_ERROR_SNIPPET_BYTES {
                                                let rem = MAX_ERROR_SNIPPET_BYTES - snippet_buf.len();
                                                let take = chunk.len().min(rem);
                                                snippet_buf.extend_from_slice(&chunk[..take]);
                                            }
                                        }
                                        Ok::<(reqwest::StatusCode, u64, Option<String>), reqwest::Error>((
                                            status,
                                            bytes_received,
                                            if is_err && !snippet_buf.is_empty() {
                                                Some(String::from_utf8_lossy(&snippet_buf).into_owned())
                                            } else {
                                                None
                                            },
                                        ))
                                    };

                                    tokio::select! {
                                        res = send_fut => {
                                            let t_ms = req_start.elapsed().as_millis() as u64;
                                            let sec = run_start.elapsed().as_secs() as u32;
                                            match res {
                                                Ok((status, bytes_received, snippet)) => {
                                                    let code = status.as_u16();
                                                    let reason = status.canonical_reason().unwrap_or("");
                                                    let is_err = !status.is_success();
                                                    let cat = if is_err {
                                                        format!("http_{}xx", code / 100)
                                                    } else {
                                                        String::new()
                                                    };
                                                    let msg = if is_err {
                                                        format!("HTTP {} {}", code, reason).trim().to_string()
                                                    } else {
                                                        String::new()
                                                    };
                                                    if let Ok(mut guard) = m.lock() {
                                                        guard.record(
                                                            sec,
                                                            &item.id,
                                                            &item.name,
                                                            &item.request.method,
                                                            &final_url,
                                                            t_ms,
                                                            bytes_received,
                                                            code,
                                                            reason,
                                                            is_err,
                                                            &cat,
                                                            &msg,
                                                            snippet,
                                                        );
                                                    }
                                                }
                                                Err(err) => {
                                                    let (cat, st_text) = classify_reqwest_error(&err);
                                                    if let Ok(mut guard) = m.lock() {
                                                        guard.record(
                                                            sec,
                                                            &item.id,
                                                            &item.name,
                                                            &item.request.method,
                                                            &final_url,
                                                            t_ms,
                                                            0,
                                                            0,
                                                            st_text,
                                                            true,
                                                            cat,
                                                            &err.to_string(),
                                                            None,
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                        _ = vu_rx.changed() => {
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        if think_ms > 0 && !*vu_rx.borrow() && Instant::now() < deadline {
                            let rem = deadline.saturating_duration_since(Instant::now());
                            let sleep_dur = Duration::from_millis(think_ms).min(rem);
                            tokio::select! {
                                _ = tokio::time::sleep(sleep_dur) => {}
                                _ = vu_rx.changed() => { break; }
                            }
                        }
                    }
                });
                vu_handles.push(handle);
            }

            while (active_vu_txs.len() as u32) > target_vus {
                if let Some(tx) = active_vu_txs.pop() {
                    let _ = tx.send(true);
                }
            }

            let cur_sec_u32 = (elapsed.as_secs() as u32).min(duration_sec.saturating_sub(1));
            if let Ok(mut guard) = metrics.lock() {
                guard.note_active_vus(cur_sec_u32, active_vu_txs.len() as u32);
            }

            let cur_sec = elapsed.as_secs() as i64;
            if cur_sec > last_tick_sec {
                last_tick_sec = cur_sec;
                let emit_sec = if cur_sec > 0 { (cur_sec - 1) as u32 } else { 0 };
                if let Ok(guard) = metrics.lock() {
                    let tick = PerfTickEvent {
                        run_id: run_id.clone(),
                        elapsed_ms: elapsed.as_millis() as u64,
                        active_vus: active_vu_txs.len() as u32,
                        unauthorized_count: guard.unauthorized_count,
                        summary: guard.snapshot_summary(elapsed_sec),
                        bucket: guard.buckets.get(&emit_sec).map(PerfRunMetrics::export_bucket),
                        endpoints: guard.export_endpoints(elapsed_sec),
                        error_groups: guard.export_error_groups(),
                        error_samples: guard.error_samples.clone(),
                    };
                    let _ = app_clone.emit("airrest:perf-tick", tick);
                }
            }
        }

        for tx in active_vu_txs.drain(..) {
            let _ = tx.send(true);
        }
        for h in vu_handles {
            let _ = h.await;
        }

        let stopped = *cancel_rx.borrow();
        let total_elapsed_ms = (run_start.elapsed().as_millis() as u64)
            .min((duration_sec as u64) * 1000)
            .max(1);
        let total_elapsed_sec = (total_elapsed_ms as f64) / 1000.0;

        if let Some(state) = app_clone.try_state::<PerfRunnerManager>() {
            if let Ok(mut guard) = state.active_runs.lock() {
                guard.remove(&run_id);
            }
        }

        if let Ok(guard) = metrics.lock() {
            let complete = PerfCompleteEvent {
                run_id: run_id.clone(),
                status: if stopped { "stopped" } else { "completed" }.to_string(),
                duration_ms: total_elapsed_ms,
                failure_reason: None,
                summary: guard.snapshot_summary(total_elapsed_sec),
                time_series: guard.buckets.values().map(PerfRunMetrics::export_bucket).collect(),
                endpoints: guard.export_endpoints(total_elapsed_sec),
                error_groups: guard.export_error_groups(),
                error_samples: guard.error_samples.clone(),
                warnings: run_warnings,
            };
            let _ = app_clone.emit("airrest:perf-complete", complete);
        }
    });

    Ok(StartRunResult {
        run_id: input.run_id,
        soft_fd_limit: soft_fd,
        effective_max_vus,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_variables_and_builtin_tokens() {
        let mut vars = HashMap::new();
        vars.insert("token".to_string(), "abc123".to_string());
        let out = interpolate_variables("Bearer {{token}} id={{$guid}} n={{$randomInt}}", &vars);
        assert!(out.starts_with("Bearer abc123 id="));
        assert!(!out.contains("{{$guid}}"));
        assert!(!out.contains("{{$randomInt}}"));
    }

    #[test]
    fn computes_load_curve_targets_across_profiles() {
        let mut handles = HashMap::new();
        handles.insert("spike".to_string(), vec![0.4, 0.5, 0.8]);
        let cfg = LoadProfileConfigInput {
            profile: "spike".to_string(),
            virtual_users: 100,
            base_load: 10,
            duration_value: 100,
            duration_unit: "seconds".to_string(),
            handles,
            staircase_steps: vec![],
            think_time_ms: 0,
        };
        assert_eq!(get_target_vus_at_time(&cfg, 10.0), 10);
        assert_eq!(get_target_vus_at_time(&cfg, 50.0), 100);
        assert_eq!(get_target_vus_at_time(&cfg, 90.0), 10);
    }

    #[test]
    fn computes_2d_staircase_targets_with_min_step_clamping() {
        let cfg = LoadProfileConfigInput {
            profile: "staircase".to_string(),
            virtual_users: 50,
            base_load: 5,
            duration_value: 20,
            duration_unit: "seconds".to_string(),
            handles: HashMap::new(),
            staircase_steps: vec![
                StaircaseStepInput {
                    end_norm: 0.05, // 1s -> clamped up to 5s (0.25)
                    virtual_users: 10,
                },
                StaircaseStepInput {
                    end_norm: 0.6,
                    virtual_users: 50,
                },
                StaircaseStepInput {
                    end_norm: 1.0,
                    virtual_users: 15,
                },
            ],
            think_time_ms: 0,
        };
        assert_eq!(get_target_vus_at_time(&cfg, 4.0), 10);
        assert_eq!(get_target_vus_at_time(&cfg, 6.0), 50);
        assert_eq!(get_target_vus_at_time(&cfg, 16.0), 15);
    }

    #[test]
    fn strips_json_comments_without_touching_urls_in_strings() {
        let input = "{\n  // line comment\n  \"url\": \"https://example.com//keep\",\n  \"ok\": true /* inline */\n}";
        let cleaned = strip_json_comments(input);
        let parsed: serde_json::Value = serde_json::from_str(&cleaned).expect("valid json");
        assert_eq!(parsed["url"], "https://example.com//keep");
        assert_eq!(parsed["ok"], true);
    }

    #[test]
    fn selects_data_rows_for_sequential_and_per_vu_modes() {
        let seq = AtomicUsize::new(0);
        assert_eq!(
            select_data_row_index(&DataFileReadMode::Sequential, 3, 0, 2, 0, &seq),
            0
        );
        assert_eq!(
            select_data_row_index(&DataFileReadMode::Sequential, 3, 0, 2, 1, &seq),
            1
        );
        assert_eq!(
            select_data_row_index(&DataFileReadMode::Sequential, 3, 0, 2, 2, &seq),
            2
        );
        assert_eq!(
            select_data_row_index(&DataFileReadMode::Sequential, 3, 0, 2, 3, &seq),
            0
        );

        // Per-VU partitioned: 5 rows across 2 VUs => VU 0 gets [0,1], VU 1 gets [2,3,4]
        assert_eq!(
            select_data_row_index(&DataFileReadMode::PerVu, 5, 0, 2, 0, &seq),
            0
        );
        assert_eq!(
            select_data_row_index(&DataFileReadMode::PerVu, 5, 0, 2, 2, &seq),
            0
        );
        assert_eq!(
            select_data_row_index(&DataFileReadMode::PerVu, 5, 1, 2, 0, &seq),
            2
        );
        assert_eq!(
            select_data_row_index(&DataFileReadMode::PerVu, 5, 1, 2, 2, &seq),
            4
        );
        // Fewer rows than peak VUs falls back cleanly modulo row count
        assert_eq!(
            select_data_row_index(&DataFileReadMode::PerVu, 2, 3, 5, 0, &seq),
            1
        );
    }

    #[test]
    fn merges_iteration_data_row_over_base_variables() {
        let mut base = HashMap::new();
        base.insert("host".to_string(), "https://api.example.com".to_string());
        base.insert("userId".to_string(), "default-user".to_string());

        let mut row = HashMap::new();
        row.insert("userId".to_string(), "csv-user-42".to_string());

        let merged = merge_vars_with_data_row(&base, Some(&row));
        assert_eq!(
            interpolate_variables("{{host}}/users/{{userId}}", merged.as_ref()),
            "https://api.example.com/users/csv-user-42"
        );
    }

    #[test]
    fn clamps_request_timeout_to_test_duration_and_defaults_to_one_minute() {
        let short_cfg = LoadProfileConfigInput {
            profile: "fixed".to_string(),
            virtual_users: 5,
            base_load: 0,
            duration_value: 10,
            duration_unit: "seconds".to_string(),
            handles: HashMap::new(),
            staircase_steps: vec![],
            think_time_ms: 0,
        };
        let short_duration_ms = (u64::from(get_duration_seconds(&short_cfg)).saturating_mul(1000)).clamp(500, 300_000);
        assert_eq!(short_duration_ms, 10_000);
        assert_eq!(60_000u64.clamp(500, short_duration_ms), 10_000);

        let long_cfg = LoadProfileConfigInput {
            duration_value: 5,
            duration_unit: "minutes".to_string(),
            ..short_cfg
        };
        let long_duration_ms = (u64::from(get_duration_seconds(&long_cfg)).saturating_mul(1000)).clamp(500, 300_000);
        assert_eq!(long_duration_ms, 300_000);
        assert_eq!(long_duration_ms.min(60_000).clamp(500, long_duration_ms), 60_000);
    }
}
