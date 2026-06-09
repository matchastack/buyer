// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type StockStatus =
  | "in_stock"
  | "out_of_stock"
  | "unknown"
  | "anti_bot"     // CAPTCHA / slider puzzle / rate-limit page detected
  | "login_required"; // session expired mid-run

export type DecisionOutcome =
  | "proceed"
  | "skip_price_exceeded"
  | "skip_dry_run"
  | "skip_unavailable"
  | "abort_anti_bot"
  | "abort_login_required";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type PaymentMethodKey = "credit_card" | "cod" | "paynow" | string;

export type ApprovalMethod = "stdin" | "telegram";

// ---------------------------------------------------------------------------
// Configuration (loaded from config.json; credentials come from env vars)
// ---------------------------------------------------------------------------

export interface Item {
  url: string;    // Full Lazada product page URL
  name: string;   // Human-readable label used in logs and confirmations
  maxPrice: number;  // Purchase is skipped if detected price exceeds this
  quantity: number;  // Units to purchase (1–10)
}

export interface Settings {
  checkIntervalMs: number;       // Base poll interval per item (ms)
  minPageLoadDelayMs: number;    // Minimum delay between page loads (rate limiting)
  maxPageLoadDelayMs: number;    // Maximum delay (adds random jitter up to this)
  headless: boolean;             // false = visible browser (needed for manual CAPTCHA)
  maxRetries: number;            // Max checkout attempts per item
  retryBackoffBaseMs: number;    // Exponential backoff base (ms)
  retryBackoffMaxMs: number;     // Cap for backoff delay (ms)
  paymentMethod: PaymentMethodKey; // Payment method to select at checkout
  dataDir: string;               // Root directory for all runtime artifacts (session, logs)
  sessionFile: string;           // Path for persisted browser cookies (default: <dataDir>/session.json)
  dryRun: boolean;               // true = monitor only, NEVER purchase
  logDir: string;                // Directory for audit log files (default: <dataDir>/logs)
  approvalMethod: ApprovalMethod; // How to gate purchases: terminal stdin or Telegram bot
}

export interface Config {
  items: Item[];
  settings: Settings;
}

// ---------------------------------------------------------------------------
// Runtime result types
// ---------------------------------------------------------------------------

export interface StockCheckResult {
  status: StockStatus;
  price: number | null;
  itemName: string;
  pageTitle: string | null;
  url: string;
  timestamp: string; // ISO-8601
}

export interface DecisionResult {
  outcome: DecisionOutcome;
  reason: string;
}

export interface OrderSummary {
  itemName: string;
  itemUrl: string;
  price: number | null;
  quantity: number;
  estimatedTotal: number | null;
  deliveryAddress: string; // As scraped from checkout page
  paymentMethod: string;   // As detected on checkout page
}

export interface CheckoutResult {
  success: boolean;
  orderNumber: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Selector system
// ---------------------------------------------------------------------------

export interface SelectorSet {
  description: string;    // What this selector targets (human-readable)
  candidates: string[];   // Tried in order; first visible match wins
  required: boolean;      // If true, failure to resolve throws; else returns null
}

export interface ResolvedSelector {
  selector: string;   // The candidate that matched
  candidateIndex: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface AuditEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  action: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  minIntervalMs: number;
  maxJitterMs: number;
}
