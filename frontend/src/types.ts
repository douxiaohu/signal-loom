export type HealthStatus = "unknown" | "healthy" | "stale" | "error";

export type SourceHealth = {
  chat_id: number;
  health_status: HealthStatus;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  fetched_count: number;
  saved_count: number;
};

export type Group = SourceHealth & {
  name: string;
  source: string | null;
  source_url?: string;
  source_type: string;
  enabled?: boolean;
  public_visible?: boolean;
  adapter?: string;
  message_count: number;
  pending_count?: number;
  last_message_time: string | null;
};

export type PublicSource = {
  chat_id: number;
  name: string;
  source_url: string;
  message_count: number;
  last_message_time: string | null;
  health_status: HealthStatus;
};

export type Message = {
  id: number;
  chat_id: number;
  chat_title: string;
  message_id: number;
  sender_name: string;
  message_time: string;
  content: string;
  media_type: string | null;
  media_urls: string[];
  media_items?: MediaItem[];
  source_url: string;
  forwarded_at?: string | null;
};

export type MediaItem = {
  url: string;
  original_url?: string;
  kind: string;
  role: string;
};

export type MediaFilter = "all" | "text" | "photo" | "video" | "document" | "animation" | "audio" | "voice" | "sticker";

export type MessagePage = {
  items: Message[];
  has_more: boolean;
  next_cursor: string | null;
  total: number | null;
};

export type OperationSummary = {
  generated_at?: string;
  sources: Array<SourceHealth & { name?: string }>;
  unhealthy_sources: Array<SourceHealth & { name?: string }>;
  public_source_count?: number;
  source_count?: number;
};

export type AlertRule = {
  id: number;
  name: string;
  keyword: string;
  media_type: string | null;
  quiet_start: string | null;
  quiet_end: string | null;
  cooldown_minutes: number;
  enabled: boolean;
  source_ids: number[];
  created_at: string;
  updated_at: string;
};

export type AlertMatch = {
  id: number;
  rule_id: number;
  rule_name: string;
  keyword: string;
  status: "new" | "acknowledged" | "resolved";
  matched_at: string;
  chat_title: string;
  sender_name: string;
  message_time: string;
  content: string;
  media_type: string | null;
};

export type Session = {
  authenticated: boolean;
  expires_at: string | number | null;
};

export type AdminView = "overview" | "sources" | "visits" | "alerts" | "messages";

export type VisitRecord = {
  id: number;
  visited_at: string;
  ip: string;
  path: string;
  method: string;
  user_agent: string;
  referer: string;
};

export type VisitStats = {
  total: number;
  unique_ips: number;
  today: number;
  today_unique: number;
  last_24h: number;
  last_7d_unique: number;
};

export type AdminOverview = {
  visits: VisitStats;
  sources: { total: number; enabled: number; public: number; unhealthy: number; items: Group[] };
  alerts: {
    new_count: number;
    pending_count?: number;
    acknowledged_count?: number;
    resolved_count?: number;
    rule_count?: number;
    enabled_rule_count?: number;
    pending_age_minutes?: number;
    trend?: Array<{ date: string; count: number }>;
  };
};

export type Filters = {
  chatId: string;
  media: MediaFilter;
  query: string;
};
