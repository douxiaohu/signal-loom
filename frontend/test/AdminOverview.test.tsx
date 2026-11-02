import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AdminOverview from "../src/components/AdminOverview";

const data = {
  visits: { total: 0, unique_ips: 0, today: 0, today_unique: 0, last_24h: 0, last_7d_unique: 0 },
  sources: { total: 0, enabled: 0, public: 0, unhealthy: 0, items: [] },
  alerts: {
    new_count: 4, pending_count: 7, acknowledged_count: 2, resolved_count: 11,
    rule_count: 5, enabled_rule_count: 3, pending_age_minutes: 95,
    trend: [{ date: "2026-09-17", count: 3 }, { date: "2026-09-18", count: 4 }]
  }
} as never;

describe("AdminOverview alert lifecycle", () => {
  it("shows rule lifecycle counts, pending age, and recent trend", () => {
    render(<AdminOverview data={data} onOpen={vi.fn()} />);
    expect(screen.getByText("规则生命周期")).toBeInTheDocument();
    expect(screen.getByText("启用规则")).toBeInTheDocument();
    expect(screen.getByText("3 / 5")).toBeInTheDocument();
    expect(screen.getByText("待处理命中")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("平均待处理时长")).toBeInTheDocument();
    expect(screen.getByText("1小时35分钟")).toBeInTheDocument();
    expect(screen.getByLabelText("规则命中趋势")).toBeInTheDocument();
    expect(screen.getByText("2026-09-18")).toBeInTheDocument();
  });

  it("draws the visits trend chart when the overview carries daily points", () => {
    const base = data as unknown as { visits: Record<string, unknown> } & Record<string, unknown>;
    const withTrend = {
      ...base,
      visits: {
        ...base.visits,
        trend: [
          { date: "2026-10-27", count: 10, unique: 7 },
          { date: "2026-10-28", count: 14, unique: 9 }
        ]
      }
    } as never;
    render(<AdminOverview data={withTrend} onOpen={vi.fn()} />);
    expect(screen.getByText("访问趋势")).toBeInTheDocument();
    expect(screen.getByLabelText("近 7 日独立访客趋势")).toBeInTheDocument();
    expect(screen.getByText("10-28")).toBeInTheDocument();
  });
});
