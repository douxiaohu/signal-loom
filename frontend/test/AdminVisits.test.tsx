import { render, screen } from "@testing-library/react";

import AdminVisits from "../src/components/AdminVisits";

const stats = { total: 9, unique_ips: 3, today: 2, today_unique: 1, last_24h: 4, last_7d_unique: 3 };
const visit = { id: 1, visited_at: "2026-07-14T08:00:00+00:00", ip: "203.0.113.7", path: "/api/public/messages", method: "GET", user_agent: "", referer: "" };

describe("AdminVisits", () => {
  it("says the log is being loaded rather than that it is empty", () => {
    render(<AdminVisits items={[]} stats={null} loading />);

    expect(screen.getByText("正在加载访问记录…")).toBeInTheDocument();
    expect(screen.queryByText("还没有访问记录")).not.toBeInTheDocument();
  });

  it("says there are no visits once loading has finished", () => {
    render(<AdminVisits items={[]} stats={stats} />);

    expect(screen.getByText("还没有访问记录")).toBeInTheDocument();
  });

  it("lists the visits it has, even while it refreshes", () => {
    render(<AdminVisits items={[visit]} stats={stats} loading />);

    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText(/直接访问 · 未知客户端/)).toBeInTheDocument();
    expect(screen.queryByText("正在加载访问记录…")).not.toBeInTheDocument();
  });
});
