import React, { useEffect, useMemo, useRef, useState } from "react";
import { PAPER_INPUT_STYLE, PAPER_SURFACE_STYLE } from "../constants/paperStyles";

export type PaperDropdownOption = { value: string; label: string };

export default function PaperDropdown({
  value,
  placeholder,
  options,
  disabled,
  searchable,
  onSelect,
}: {
  value: string;
  placeholder: string;
  options: readonly PaperDropdownOption[];
  disabled?: boolean;
  searchable?: boolean;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current && ref.current.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const resolvedLabel = useMemo(() => {
    const found = options.find((opt) => opt.value === value);
    return found?.label ?? placeholder;
  }, [options, placeholder, value]);

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q));
  }, [options, query, searchable]);

  const fieldStyle: React.CSSProperties = {
    ...(PAPER_INPUT_STYLE as unknown as React.CSSProperties),
    width: "100%",
    borderRadius: 10,
    padding: "8px 10px",
    outline: "none",
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          ...fieldStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{resolvedLabel}</span>
        <span aria-hidden style={{ fontSize: 12, opacity: 0.8 }}>
          ▼
        </span>
      </button>
      {open ? (
        <div
          style={{
            ...(PAPER_SURFACE_STYLE as unknown as React.CSSProperties),
            position: "absolute",
            left: 0,
            right: 0,
            top: "100%",
            marginTop: 6,
            zIndex: 10,
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 10px 26px rgba(0,0,0,0.35)",
          }}
        >
          {searchable ? (
            <div style={{ padding: 8, borderBottom: "1px solid rgba(120,80,40,0.2)" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск..."
                style={{ ...fieldStyle, padding: "7px 10px" }}
                autoFocus
              />
            </div>
          ) : null}
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {filtered.map((opt) => (
              <button
                key={opt.value || "__empty"}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(opt.value);
                  setOpen(false);
                  setQuery("");
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  border: 0,
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "inherit",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                {opt.label}
              </button>
            ))}
            {filtered.length === 0 ? (
              <div style={{ padding: "10px 10px", fontSize: 12, opacity: 0.75 }}>Ничего не найдено</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

