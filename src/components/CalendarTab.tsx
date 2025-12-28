import React, { useEffect, useMemo, useRef, useState } from "react";
import moment from "moment-timezone";
import "moment/locale/ru";
import { BUTTON_SECONDARY } from "../constants/buttonPalette";

type CalendarEvent = {
  kind: "tithi" | "sankranti" | "eclipse" | "window";
  summary: string;
  start_utc: string;
  end_utc: string;
  is_all_day: boolean;
  start_date?: string | null;
  end_date?: string | null;
  meta?: Record<string, unknown>;
};

type CalendarYearResponse = {
  year: number;
  iana_tz: string;
  events: CalendarEvent[];
};

function escapeIcsText(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function formatIcsUtc(dtIso: string): string {
  return moment.parseZone(dtIso).utc().format("YYYYMMDDTHHmmss[Z]");
}

function formatIcsDate(dateIso: string): string {
  // dateIso: YYYY-MM-DD
  return dateIso.replace(/-/g, "");
}

function buildIcs(args: { year: number; ianaTz: string; events: CalendarEvent[] }): string {
  const dtstamp = moment.utc().format("YYYYMMDDTHHmmss[Z]");
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Synastry//Calendar//RU",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(`Астрологический календарь ${args.year}`)}`,
    `X-WR-TIMEZONE:${escapeIcsText(args.ianaTz)}`,
  ];

  args.events.forEach((ev, idx) => {
    const uid = `${args.year}-${idx}-${ev.kind}-${formatIcsUtc(ev.start_utc)}@synastry`;
    lines.push("BEGIN:VEVENT");
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`UID:${uid}`);

    if (ev.is_all_day && ev.start_date && ev.end_date) {
      lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(ev.start_date)}`);
      lines.push(`DTEND;VALUE=DATE:${formatIcsDate(ev.end_date)}`);
      lines.push("TRANSP:TRANSPARENT");
    } else {
      lines.push(`DTSTART:${formatIcsUtc(ev.start_utc)}`);
      lines.push(`DTEND:${formatIcsUtc(ev.end_utc)}`);
      lines.push("TRANSP:OPAQUE");
    }

    lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`);
    lines.push("STATUS:CONFIRMED");
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function eventColor(ev: CalendarEvent): string {
  if (ev.kind === "window") return "#16a34a";
  if (ev.kind === "tithi") return "#dc2626";
  if (ev.kind === "sankranti") return "#ea580c";
  return "#991b1b";
}

type LocalEventRange = {
  ev: CalendarEvent;
  startLocal: moment.Moment;
  endLocal: moment.Moment;
  startDay: moment.Moment;
  endDayExcl: moment.Moment;
};

type ExpandedEvent = {
  range: LocalEventRange;
  color: string;
  anchor: { left: number; top: number; width: number; height: number };
};

type ExpandedEventList = {
  items: Array<{ range: LocalEventRange; color: string }>;
  anchor: { left: number; top: number; width: number; height: number };
};

function computeLocalRange(ev: CalendarEvent, ianaTz: string): LocalEventRange {
  if (ev.is_all_day && ev.start_date && ev.end_date) {
    const startDay = moment.tz(ev.start_date, "YYYY-MM-DD", ianaTz).startOf("day");
    const endDayExcl = moment.tz(ev.end_date, "YYYY-MM-DD", ianaTz).startOf("day");
    return {
      ev,
      startLocal: startDay.clone(),
      endLocal: endDayExcl.clone(),
      startDay,
      endDayExcl,
    };
  }

  const startLocal = moment.parseZone(ev.start_utc).tz(ianaTz);
  const endLocal = moment.parseZone(ev.end_utc).tz(ianaTz);
  const startDay = startLocal.clone().startOf("day");
  const endStart = endLocal.clone().startOf("day");
  const endDayExcl = endLocal.isSame(endStart) ? endStart : endStart.clone().add(1, "day");
  return { ev, startLocal, endLocal, startDay, endDayExcl };
}

type WeekSegment = {
  key: string;
  range: LocalEventRange;
  colStart: number;
  colEnd: number; // exclusive
  label: string;
  color: string;
  continuesLeft: boolean;
  continuesRight: boolean;
  track: number;
};

function buildWeekSegments(args: {
  weekStartDay: moment.Moment;
  ranges: LocalEventRange[];
  maxTracks: number;
  clipStartDay?: moment.Moment;
  clipEndDayExcl?: moment.Moment;
}): { visibleSegments: WeekSegment[]; hiddenSegments: WeekSegment[] } {
  const weekStartDay = args.weekStartDay.clone().startOf("day");
  const weekEndDay = weekStartDay.clone().add(7, "day");
  const clipStartDay = args.clipStartDay ? args.clipStartDay.clone().startOf("day") : null;
  const clipEndDayExcl = args.clipEndDayExcl ? args.clipEndDayExcl.clone().startOf("day") : null;

  const raw: Omit<WeekSegment, "track">[] = [];
  for (const r of args.ranges) {
    if (!r.endDayExcl.isAfter(weekStartDay) || !r.startDay.isBefore(weekEndDay)) continue;

    let segStart = moment.max(r.startDay, weekStartDay);
    let segEndExcl = moment.min(r.endDayExcl, weekEndDay);
    if (clipStartDay) segStart = moment.max(segStart, clipStartDay);
    if (clipEndDayExcl) segEndExcl = moment.min(segEndExcl, clipEndDayExcl);
    if (!segEndExcl.isAfter(segStart)) continue;

    const colStart = segStart.diff(weekStartDay, "days");
    const colEnd = colStart + segEndExcl.diff(segStart, "days");
    if (colEnd <= colStart) continue;

    const showTime = !r.ev.is_all_day && segStart.isSame(r.startDay);
    const timePrefix = showTime ? `${r.startLocal.format("HH:mm")} ` : "";
    const label = `${timePrefix}${r.ev.summary}`.trim();

    raw.push({
      key: `${r.ev.kind}:${r.ev.start_utc}:${colStart}:${colEnd}:${r.ev.summary}`,
      range: r,
      colStart,
      colEnd,
      label,
      color: eventColor(r.ev),
      continuesLeft: r.startDay.isBefore(weekStartDay),
      continuesRight: r.endDayExcl.isAfter(weekEndDay),
    });
  }

  raw.sort((a, b) => (a.colStart - b.colStart) || (b.colEnd - a.colEnd) || a.label.localeCompare(b.label));

  const trackEnds: number[] = [];
  const segments: WeekSegment[] = [];
  for (const seg of raw) {
    let track = trackEnds.findIndex((end) => end <= seg.colStart);
    if (track === -1) {
      track = trackEnds.length;
      trackEnds.push(seg.colEnd);
    } else {
      trackEnds[track] = seg.colEnd;
    }
    segments.push({ ...seg, track });
  }

  const visible = segments.filter((s) => s.track < args.maxTracks);
  const hidden = segments.filter((s) => s.track >= args.maxTracks);
  return { visibleSegments: visible, hiddenSegments: hidden };
}

function formatExpandedRange(range: LocalEventRange): string {
  const start = range.startLocal.clone().locale("ru");
  const end = range.endLocal.clone().locale("ru");

  if (range.ev.is_all_day && range.ev.start_date && range.ev.end_date) {
    const endInclusive = range.endLocal.clone().add(-1, "day");
    if (endInclusive.isSame(start, "day")) return `${start.format("D MMM")}`;
    return `${start.format("D MMM")} – ${endInclusive.format("D MMM")}`;
  }

  if (start.isSame(end, "day")) return `${start.format("D MMM HH:mm")} – ${end.format("HH:mm")}`;
  return `${start.format("D MMM HH:mm")} – ${end.format("D MMM HH:mm")}`;
}

function formatUtcOffsetShort(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  if (mm === 0) return `UTC${sign}${hh}`;
  const mm2 = String(mm).padStart(2, "0");
  return `UTC${sign}${hh}:${mm2}`;
}

export default function CalendarTab(props: {
  apiBaseUrl: string;
  ianaTz: string;
  onSelectDayMsUtc?: (msUtc: number, ctx: { dateIso: string; ianaTz: string }) => void;
  gatakiEnabled?: boolean;
  onToggleGataki?: () => void;
  gatakiDisabled?: boolean;
}) {
  const systemTz = useMemo(() => {
    const guessed = moment.tz.guess();
    if (guessed && moment.tz.zone(guessed)) return guessed;
    return props.ianaTz;
  }, [props.ianaTz]);

  const now = useMemo(() => moment.tz(systemTz), [systemTz]);
  const [year, setYear] = useState<number>(now.year());
  const [month, setMonth] = useState<number>(now.month());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CalendarYearResponse | null>(null);
  const [selectedDateIso, setSelectedDateIso] = useState<string>(() => now.format("YYYY-MM-DD"));
  const [expanded, setExpanded] = useState<ExpandedEvent | null>(null);
  const [expandedList, setExpandedList] = useState<ExpandedEventList | null>(null);
  const cacheRef = useRef<Map<string, CalendarYearResponse>>(new Map());

  const selectDate = (dateIso: string) => {
    setSelectedDateIso(dateIso);
    if (!props.onSelectDayMsUtc) return;
    const msUtc = moment.tz(dateIso, "YYYY-MM-DD", systemTz).startOf("day").add(12, "hours").valueOf();
    if (!Number.isFinite(msUtc)) return;
    props.onSelectDayMsUtc(msUtc, { dateIso, ianaTz: systemTz });
  };

  useEffect(() => {
    const key = `${year}::${systemTz}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setData(cached);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const endpoint = `${props.apiBaseUrl.replace(/\/$/, "")}/api/calendar-year`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ year, iana_tz: systemTz }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Ошибка сервера: ${res.status} ${txt}`);
        }
        const json = (await res.json()) as CalendarYearResponse;
        if (controller.signal.aborted) return;
        cacheRef.current.set(key, json);
        setData(json);
      } catch (err) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [props.apiBaseUrl, systemTz, year]);

  useEffect(() => {
    if (!expanded && !expandedList) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(null);
        setExpandedList(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, expandedList]);

  const eventRanges = useMemo(() => {
    const events = data?.events ?? [];
    return events.map((ev) => computeLocalRange(ev, systemTz));
  }, [data?.events, systemTz]);

  const monthStart = useMemo(() => moment.tz({ year, month, day: 1 }, systemTz).startOf("day"), [month, systemTz, year]);
  const monthEnd = useMemo(() => monthStart.clone().endOf("month").startOf("day"), [monthStart]);
  const visibleStartDay = useMemo(() => monthStart.clone().startOf("day"), [monthStart]);
  const visibleEndDayExcl = useMemo(() => monthEnd.clone().add(1, "day").startOf("day"), [monthEnd]);

  const { cells, weeksCount, firstGridDay } = useMemo(() => {
    const daysInMonth = monthStart.daysInMonth();
    const blanksBefore = monthStart.isoWeekday() - 1; // 0..6, Monday=1
    const totalCells = blanksBefore + daysInMonth;
    const weeks = Math.ceil(totalCells / 7);
    const cellCount = weeks * 7;
    const out: Array<moment.Moment | null> = [];
    for (let i = 0; i < cellCount; i++) {
      const dayNum = i - blanksBefore + 1;
      if (dayNum < 1 || dayNum > daysInMonth) out.push(null);
      else out.push(monthStart.clone().date(dayNum));
    }
    const first = monthStart.clone().subtract(blanksBefore, "day").startOf("day");
    return { cells: out, weeksCount: weeks, firstGridDay: first };
  }, [monthStart]);

  const monthLabel = monthStart.clone().locale("en").format("MMM YYYY");
  const utcOffsetLabel = useMemo(() => formatUtcOffsetShort(monthStart.utcOffset()), [monthStart]);
  const tzLabel = useMemo(() => `${utcOffsetLabel} (сист.)`, [utcOffsetLabel]);
  const maxTracks = 3;
  const headerHeightPx = 11;
  const trackHeightPx = 10;
  const calendarButtonStyle = useMemo<React.CSSProperties>(
    () => ({
      background: "#fff3d8",
      color: "#1f1309",
      border: "1px solid #000",
      fontWeight: 400,
    }),
    [],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0, height: "100%", overflow: "hidden", fontWeight: 400 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "nowrap" }}>
        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
          <div style={{ display: "flex" }}>
            {[
              { label: "− год", onClick: () => setYear((y) => y - 1) },
              { label: "+ год", onClick: () => setYear((y) => y + 1) },
            ].map((b, idx) => (
              <button
                key={b.label}
                type="button"
                className={`${BUTTON_SECONDARY} px-2 py-1 text-sm shadow-[0_0_0_1px_rgba(99,102,241,0.35)]`}
                style={{ ...calendarButtonStyle, marginLeft: idx === 0 ? 0 : -1 }}
                onClick={b.onClick}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex" }}>
            {[
              {
                label: "←",
                onClick: () =>
                  setMonth((m) => {
                    if (m === 0) {
                      setYear((y) => y - 1);
                      return 11;
                    }
                    return m - 1;
                  }),
              },
              {
                label: "→",
                onClick: () =>
                  setMonth((m) => {
                    if (m === 11) {
                      setYear((y) => y + 1);
                      return 0;
                    }
                    return m + 1;
                  }),
              },
            ].map((b, idx) => (
              <button
                key={b.label}
                type="button"
                className={`${BUTTON_SECONDARY} px-2 py-1 text-sm shadow-[0_0_0_1px_rgba(99,102,241,0.35)]`}
                style={{ ...calendarButtonStyle, marginLeft: idx === 0 ? 0 : -1, width: 34 }}
                onClick={b.onClick}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 15, color: "#000", fontWeight: 400, lineHeight: "16px" }}>
            {monthLabel}/{tzLabel}
          </div>
        </div>

        <div style={{ display: "flex" }}>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm shadow-[0_0_0_1px_rgba(99,102,241,0.35)]`}
            style={{
              ...calendarButtonStyle,
              marginLeft: 0,
              marginRight: -1,
              background: props.gatakiEnabled ? "#864240" : calendarButtonStyle.background,
              color: props.gatakiEnabled ? "#fff" : calendarButtonStyle.color,
              boxShadow: props.gatakiEnabled ? "inset 0 1px 2px rgba(0,0,0,0.35)" : calendarButtonStyle.boxShadow,
            }}
            aria-pressed={Boolean(props.gatakiEnabled)}
            disabled={props.gatakiDisabled}
            onClick={() => props.onToggleGataki?.()}
            title={props.gatakiDisabled ? "Доступно только с лицензией" : undefined}
          >
            Гатаки
          </button>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm shadow-[0_0_0_1px_rgba(99,102,241,0.35)]`}
            style={{ ...calendarButtonStyle, marginLeft: 0 }}
            disabled={!data || loading}
            onClick={() => {
              if (!data) return;
              const ics = buildIcs({ year, ianaTz: systemTz, events: data.events });
              downloadTextFile(`Synastry-календарь-${year}.ics`, ics);
            }}
          >
            Скачать .ics
          </button>
        </div>
      </div>

      {loading ? <div style={{ fontSize: 13, color: "#000" }}>Расчёт календаря…</div> : null}
      {error ? <div style={{ fontSize: 13, color: "#9b1c1c", whiteSpace: "pre-line" }}>{error}</div> : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 0, minHeight: 0, flex: "1 1 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 0, marginTop: 0, marginBottom: 0 }}>
          {["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"].map((d) => (
            <div key={d} style={{ fontSize: 11, color: "#000", textAlign: "center", fontWeight: 400, lineHeight: "12px", padding: "0 0 1px" }}>
              {d}
            </div>
          ))}
        </div>

        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflow: "hidden",
            border: "1px solid #000",
            background: "#fff3d8",
            display: "flex",
            flexDirection: "column",
          }}
        >
        {Array.from({ length: weeksCount }).map((_, weekIdx) => {
          const weekCells = cells.slice(weekIdx * 7, weekIdx * 7 + 7);
          const weekStartDay = firstGridDay.clone().add(weekIdx * 7, "day");

          const weekInfo = buildWeekSegments({
            weekStartDay,
            ranges: eventRanges,
            maxTracks,
            clipStartDay: visibleStartDay,
            clipEndDayExcl: visibleEndDayExcl,
          });
          const segments = weekInfo.visibleSegments;
          const hiddenSegments = weekInfo.hiddenSegments;
          const hiddenCount = hiddenSegments.length;
          const overflowCol = hiddenCount ? Math.min(...hiddenSegments.map((s) => s.colStart)) : null;

          return (
            <div
              key={`week-${weekIdx}`}
              style={{
                position: "relative",
                flex: "1 1 0",
                minHeight: 0,
                display: "grid",
                gridTemplateColumns: "repeat(7, 1fr)",
                borderBottom: weekIdx < weeksCount - 1 ? "1px solid rgba(0,0,0,0.35)" : "none",
                overflow: "hidden",
              }}
            >
              {weekCells.map((day, idx) => {
                if (!day) {
                  return (
                    <div
                      key={`empty-${weekIdx}-${idx}`}
                      style={{
                        position: "relative",
                        border: "none",
                        borderRight: idx < 6 ? "1px solid rgba(0,0,0,0.35)" : "none",
                        borderBottom: "none",
                        background: "#f1d6ae",
                      }}
                    />
                  );
                }

                const dayIso = day.format("YYYY-MM-DD");
                const isSelected = dayIso === selectedDateIso;
                const showOverflow = typeof overflowCol === "number" && overflowCol === idx && hiddenCount > 0;
                return (
                  <button
                    key={dayIso}
                    type="button"
                    onClick={() => selectDate(dayIso)}
                    className="text-left"
                    style={{
                      position: "relative",
                      border: "none",
                      outline: "none",
                      borderRight: idx < 6 ? "1px solid rgba(0,0,0,0.35)" : "none",
                      borderBottom: "none",
                      background: isSelected ? "rgba(0,0,0,0.08)" : "#fff3d8",
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 1,
                        right: 1,
                        height: 10,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontSize: 10,
                        lineHeight: "10px",
                        color: "#000",
                        fontWeight: 400,
                        zIndex: 3,
                      }}
                    >
                      <span style={{ pointerEvents: "none" }}>{day.date()}</span>
                      {showOverflow ? (
                        <div
                          role="button"
                          tabIndex={0}
                          title="Ещё события (не поместились по высоте)"
                          style={{
                            background: "rgba(0,0,0,0.35)",
                            color: "#fff",
                            padding: "0 4px",
                            borderRadius: 6,
                            cursor: "pointer",
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                            setExpanded(null);
                            setExpandedList({
                              items: hiddenSegments.map((s) => ({ range: s.range, color: s.color })),
                              anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                            });
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                            setExpanded(null);
                            setExpandedList({
                              items: hiddenSegments.map((s) => ({ range: s.range, color: s.color })),
                              anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                            });
                          }}
                        >
                          +{hiddenCount}
                        </div>
                      ) : null}
                    </div>
                  </button>
                );
              })}

              <div
                style={{
                  position: "absolute",
                  left: 1,
                  right: 1,
                  top: headerHeightPx,
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 1fr)",
                  gridTemplateRows: `repeat(${maxTracks}, ${trackHeightPx}px)`,
                  rowGap: 1,
                  pointerEvents: "none",
                  zIndex: 1,
                }}
              >
                {segments.map((seg) => {
                  const radius = 6;
                  const style: React.CSSProperties = {
                    gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 1}`,
                    gridRow: `${seg.track + 1}`,
                    background: seg.color,
                    color: "#fff",
                    fontSize: 10,
                    lineHeight: `${trackHeightPx}px`,
                    padding: "0 6px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    borderTopLeftRadius: seg.continuesLeft ? 0 : radius,
                    borderBottomLeftRadius: seg.continuesLeft ? 0 : radius,
                    borderTopRightRadius: seg.continuesRight ? 0 : radius,
                    borderBottomRightRadius: seg.continuesRight ? 0 : radius,
                    fontWeight: 400,
                    pointerEvents: "auto",
                    cursor: "pointer",
                  };
                  return (
                    <div
                      key={seg.key}
                      style={style}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                        setExpanded({
                          range: seg.range,
                          color: seg.color,
                          anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                        });
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                        setExpanded({
                          range: seg.range,
                          color: seg.color,
                          anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                        });
                      }}
                    >
                      {seg.label}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {expanded ? (
        <div
          role="presentation"
          onMouseDown={() => setExpanded(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "transparent",
          }}
        >
          {(() => {
            const maxWidth = Math.min(360, window.innerWidth - 20);
            const minWidth = Math.min(170, maxWidth);
            const left = Math.max(10, Math.min(expanded.anchor.left, window.innerWidth - maxWidth - 10));
            const top = Math.min(expanded.anchor.top + expanded.anchor.height + 8, window.innerHeight - 140);
            return (
          <div
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left,
              top,
              width: "fit-content",
              minWidth,
              maxWidth,
              background: expanded.color,
              color: "#fff",
              border: "1px solid rgba(0,0,0,0.85)",
              borderRadius: 10,
              padding: "10px 12px",
              boxShadow: "0 10px 35px rgba(0,0,0,0.35)",
              transformOrigin: "top left",
              animation: "synCalendarPop 120ms ease-out",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 400, lineHeight: "18px", whiteSpace: "normal" }}>{expanded.range.ev.summary}</div>
              <button
                type="button"
                aria-label="Закрыть"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setExpanded(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#000",
                  fontSize: 18,
                  lineHeight: "18px",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, fontWeight: 400 }}>
              {formatExpandedRange(expanded.range)}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.95 }}>{tzLabel}</div>
          </div>
            );
          })()}
          <style>{`
            @keyframes synCalendarPop {
              from { opacity: 0; transform: translateY(-2px) scale(0.98); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>
        </div>
      ) : null}

      {expandedList ? (
        <div
          role="presentation"
          onMouseDown={() => setExpandedList(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "transparent",
          }}
        >
          {(() => {
            const maxWidth = Math.min(420, window.innerWidth - 20);
            const minWidth = Math.min(220, maxWidth);
            const left = Math.max(10, Math.min(expandedList.anchor.left, window.innerWidth - maxWidth - 10));
            const top = Math.min(expandedList.anchor.top + expandedList.anchor.height + 8, window.innerHeight - 200);
            return (
              <div
                role="dialog"
                aria-modal="true"
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: "fixed",
                  left,
                  top,
                  width: "fit-content",
                  minWidth,
                  maxWidth,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  transformOrigin: "top left",
                  animation: "synCalendarPop 120ms ease-out",
                }}
              >
                {expandedList.items.map((it, idx) => (
                  <div
                    key={`${it.range.ev.kind}:${it.range.ev.start_utc}:${idx}`}
                    style={{
                      background: it.color,
                      color: "#fff",
                      border: "1px solid rgba(0,0,0,0.85)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      boxShadow: "0 10px 35px rgba(0,0,0,0.35)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 400, lineHeight: "18px", whiteSpace: "normal" }}>
                        {it.range.ev.summary}
                      </div>
                      {idx === 0 ? (
                        <button
                          type="button"
                          aria-label="Закрыть"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => setExpandedList(null)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "#000",
                            fontSize: 18,
                            lineHeight: "18px",
                            padding: 0,
                            cursor: "pointer",
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13, fontWeight: 400 }}>
                      {formatExpandedRange(it.range)}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.95 }}>{tzLabel}</div>
                  </div>
                ))}
              </div>
            );
          })()}
          <style>{`
            @keyframes synCalendarPop {
              from { opacity: 0; transform: translateY(-2px) scale(0.98); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>
        </div>
      ) : null}
    </div>
  );
}
