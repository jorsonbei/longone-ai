import React, { useCallback, useEffect, useMemo, useState } from "react";

type EnergyCard = {
  card_type: string;
  adapter_id: string;
  dataset: string;
  task: string;
  DateTime?: string;
  zone?: string;
  horizon_name?: string;
  load_now?: number | null;
  foundation_p10?: number | null;
  foundation_p50?: number | null;
  foundation_p90?: number | null;
  high_threshold_p90_history?: number | null;
  v28_warning_level?: string;
  status: string;
  v28_selected_strategy?: string;
};

type Head = {
  adapter_id: string;
  dataset: string;
  task: string;
  task_family: string;
  metric_name: string;
  foundation_metric: number;
  head_status: "deployable" | "watchlist" | "blocked";
  selector_reason: string;
  stability_score: number;
  runtime_policy: string;
};

type Summary = {
  version: string;
  v3_0?: {
    heads_total: number;
    deployable_heads: number;
    watchlist_heads: number;
    blocked_heads: number;
    runtime_cards: number;
    datasets: string[];
    adapters: string[];
  };
  new_energy_source_types?: string[];
};

type CardsPayload = {
  runtime_cards_count: number;
  capability_cards_count: number;
  cards: EnergyCard[];
};

type Props = {
  apiBase?: string;
  refreshIntervalMs?: number;
};

function fmt(value?: number | null, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function metricLabel(head: Head) {
  const better = head.metric_name === "auc" ? "越高越好" : "越低越好";
  return `${head.metric_name.toUpperCase()} ${fmt(head.foundation_metric, 4)}（${better}）`;
}

export default function EnergyRuntimePage({
  apiBase = "",
  refreshIntervalMs = 300_000,
}: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cards, setCards] = useState<EnergyCard[]>([]);
  const [heads, setHeads] = useState<Head[]>([]);
  const [watchlist, setWatchlist] = useState<Head[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDataset, setSelectedDataset] = useState("ALL");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = (path: string) => `${apiBase.replace(/\/$/, "")}${path}`;
      const now = Date.now();
      const [summaryRes, cardsRes, headsRes, watchRes] = await Promise.all([
        fetch(endpoint(`/api/energy/summary?t=${now}`), { cache: "no-store" }),
        fetch(endpoint(`/api/energy/cards?t=${now}`), { cache: "no-store" }),
        fetch(endpoint(`/api/energy/heads?status=deployable&t=${now}`), { cache: "no-store" }),
        fetch(endpoint(`/api/energy/watchlist?t=${now}`), { cache: "no-store" }),
      ]);
      if (!summaryRes.ok || !cardsRes.ok || !headsRes.ok || !watchRes.ok) {
        throw new Error("能源预测接口返回异常，请刷新或检查主服务。");
      }
      const summaryJson = await summaryRes.json();
      const cardsJson: CardsPayload = await cardsRes.json();
      const headsJson = await headsRes.json();
      const watchJson = await watchRes.json();
      setSummary(summaryJson);
      setCards(cardsJson.cards || []);
      setHeads(headsJson.records || []);
      setWatchlist(watchJson.records || []);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, refreshIntervalMs);
    return () => window.clearInterval(id);
  }, [load, refreshIntervalMs]);

  const datasets = useMemo(() => {
    const set = new Set(cards.map((c) => c.dataset).concat(heads.map((h) => h.dataset)));
    return ["ALL", ...Array.from(set).sort()];
  }, [cards, heads]);

  const filteredCards = useMemo(() => {
    if (selectedDataset === "ALL") return cards;
    return cards.filter((c) => c.dataset === selectedDataset);
  }, [cards, selectedDataset]);

  const runtimeCards = filteredCards.filter((c) => c.card_type === "load_forecast_runtime_card");
  const capabilityCards = filteredCards.filter((c) => c.card_type === "capability_card");

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>HFCD Energy Runtime</p>
          <h1 style={styles.title}>能源预测与新能源接入</h1>
          <p style={styles.subtitle}>
            统一展示 V3.0 deployable heads、实时负载预测卡片，以及光伏/风电/储能/电池循环 CSV 接入状态。
          </p>
        </div>
        <button style={styles.button} onClick={load} disabled={loading}>
          {loading ? "刷新中..." : "刷新"}
        </button>
      </header>

      {error ? <div style={styles.error}>接口错误：{error}</div> : null}

      <section style={styles.metrics}>
        <Metric label="总 heads" value={summary?.v3_0?.heads_total ?? "-"} />
        <Metric label="可部署" value={summary?.v3_0?.deployable_heads ?? "-"} />
        <Metric label="观察" value={summary?.v3_0?.watchlist_heads ?? "-"} />
        <Metric label="阻断" value={summary?.v3_0?.blocked_heads ?? "-"} />
      </section>

      <section style={styles.toolbar}>
        <span>数据集</span>
        <select value={selectedDataset} onChange={(e) => setSelectedDataset(e.target.value)} style={styles.select}>
          {datasets.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <span style={styles.muted}>数据源：主服务 /api/energy</span>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>实时负载预测卡片</h2>
        <div style={styles.grid}>
          {runtimeCards.map((card) => (
            <article key={`${card.dataset}-${card.task}`} style={styles.card}>
              <p style={styles.cardMeta}>{card.dataset} · {card.zone} · {card.horizon_name}</p>
              <h3 style={styles.cardTitle}>{card.task}</h3>
              <p style={styles.line}>时间：{card.DateTime || "-"}</p>
              <p style={styles.line}>当前负载：{fmt(card.load_now)} · p50：{fmt(card.foundation_p50)} · p10/p90：{fmt(card.foundation_p10)} / {fmt(card.foundation_p90)}</p>
              <p style={styles.line}>状态：{card.status} · 风险：{card.v28_warning_level || "-"}</p>
              <p style={styles.line}>策略：{card.v28_selected_strategy || "-"}</p>
            </article>
          ))}
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>可部署能力头</h2>
        <div style={styles.grid}>
          {capabilityCards.map((card) => (
            <article key={`${card.dataset}-${card.task}`} style={styles.card}>
              <p style={styles.cardMeta}>{card.adapter_id}</p>
              <h3 style={styles.cardTitle}>{card.dataset}</h3>
              <p style={styles.line}>{card.task}</p>
              <p style={styles.line}>状态：{card.status}</p>
            </article>
          ))}
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Head Selector</h2>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th>adapter</th>
                <th>dataset</th>
                <th>task</th>
                <th>metric</th>
                <th>score</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {heads.slice(0, 24).map((h) => (
                <tr key={`${h.dataset}-${h.task}`}>
                  <td>{h.adapter_id}</td>
                  <td>{h.dataset}</td>
                  <td>{h.task}</td>
                  <td>{metricLabel(h)}</td>
                  <td>{fmt(h.stability_score, 3)}</td>
                  <td>{h.selector_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Watchlist / Blocked</h2>
        <div style={styles.grid}>
          {watchlist.slice(0, 12).map((h) => (
            <article key={`${h.dataset}-${h.task}`} style={{ ...styles.card, borderColor: h.head_status === "blocked" ? "#7a2c2c" : "#67552e" }}>
              <p style={styles.cardMeta}>{h.head_status} · {h.adapter_id}</p>
              <h3 style={styles.cardTitle}>{h.dataset}</h3>
              <p style={styles.line}>{h.task}</p>
              <p style={styles.line}>{h.selector_reason}</p>
            </article>
          ))}
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>新能源数据接入</h2>
        <p style={styles.subtitle}>
          支持模板：{summary?.new_energy_source_types?.join(" / ") || "solar_pv / wind_power / storage_dispatch / battery_cycle"}。
          真实 CSV 先调用 <code>/api/energy/adapt-csv</code> 做 schema 与 HFCD 最新窗口体检，不能跳过冻结回测直接上线。
        </p>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <strong style={styles.metricValue}>{value}</strong>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#071312",
    color: "#f0fff9",
    padding: 28,
    fontFamily: '"Avenir Next", "PingFang SC", sans-serif',
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 24,
    alignItems: "flex-start",
    marginBottom: 22,
  },
  eyebrow: { color: "#7ff0c4", letterSpacing: 2, textTransform: "uppercase", fontSize: 12, margin: 0 },
  title: { fontSize: 36, margin: "8px 0", lineHeight: 1.1 },
  subtitle: { color: "#9fb4c7", maxWidth: 900, lineHeight: 1.7, margin: 0 },
  button: {
    border: "1px solid #64d7ae",
    background: "#12352f",
    color: "#aaf5d3",
    padding: "11px 18px",
    borderRadius: 14,
    cursor: "pointer",
    fontWeight: 700,
  },
  error: { background: "#4a1515", border: "1px solid #a54040", padding: 14, borderRadius: 14, marginBottom: 18 },
  metrics: { display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 14, marginBottom: 20 },
  metric: { background: "#10201f", border: "1px solid #23413d", borderRadius: 18, padding: 18 },
  metricLabel: { color: "#89a2b9", display: "block", marginBottom: 8 },
  metricValue: { fontSize: 28 },
  toolbar: { display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "#a7bdcf" },
  select: { background: "#10201f", color: "#f0fff9", border: "1px solid #2c514a", borderRadius: 10, padding: "8px 10px" },
  muted: { color: "#697d8e", marginLeft: "auto" },
  section: { marginTop: 26 },
  sectionTitle: { fontSize: 22, marginBottom: 14 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 },
  card: { background: "#101d1d", border: "1px solid #24413d", borderRadius: 20, padding: 18 },
  cardMeta: { color: "#7e93ad", margin: 0, fontWeight: 700, letterSpacing: 1 },
  cardTitle: { margin: "8px 0 12px", fontSize: 20 },
  line: { color: "#b8c7d5", margin: "6px 0", lineHeight: 1.55 },
  tableWrap: { overflowX: "auto", background: "#101d1d", border: "1px solid #24413d", borderRadius: 18 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
};
