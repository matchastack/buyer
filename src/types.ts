export interface Item {
  url: string;
  name: string;
  maxPrice: number;
  quantity: number;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface Settings {
  // How often to check each item page for stock availability (milliseconds)
  checkIntervalMs: number;
  // Run browser visibly (false) or in background (true). Use false when dealing with CAPTCHAs.
  headless: boolean;
  // Max attempts to complete checkout before giving up on an item
  maxRetries: number;
  // Payment method to select at checkout: "cod", "credit_card", or a partial label match
  paymentMethod: string;
  // Path to persist the browser session (cookies/storage) so login survives restarts
  sessionFile: string;
}

export interface Config {
  credentials: Credentials;
  items: Item[];
  settings: Settings;
}

export type StockStatus = "available" | "out_of_stock" | "unknown";

export interface CheckResult {
  status: StockStatus;
  price: number | null;
  itemName: string;
}
