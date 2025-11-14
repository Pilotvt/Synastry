import type { FC } from "react";

type HouseLabel = {
  houseNumber: number;
  sign: string;
  signIndex: number | null;
  signLabel?: string;
  planetLabels?: string[];
  aspectLabels?: string[];
};

type NorthIndianChartProps = {
  title?: string;
  className?: string;
  houses?: HouseLabel[];
  centered?: boolean;
};

const WIDTH = 600;
const HEIGHT = 400;

const BASE_LINES = [
  { x1: 0, y1: 0, x2: WIDTH, y2: HEIGHT },
  { x1: WIDTH, y1: 0, x2: 0, y2: HEIGHT },
];

const PARALLEL_TO_DIAG2 = [
  // верхний сегмент AB
  { x1: WIDTH / 2, y1: 0, x2: 0, y2: HEIGHT / 2 },
  // нижний сегмент BC
  { x1: WIDTH, y1: HEIGHT / 2, x2: WIDTH / 2, y2: HEIGHT },
];

const PARALLEL_TO_DIAG1 = [
  // через верхнюю половину второй диагонали
  { x1: WIDTH / 2, y1: 0, x2: WIDTH, y2: HEIGHT / 2 },
  // через нижнюю половину второй диагонали
  { x1: 0, y1: HEIGHT / 2, x2: WIDTH / 2, y2: HEIGHT },
];

const LINE_STYLE = {
  stroke: "rgba(255,255,255,0.72)",
  strokeWidth: 2,
};

const SIGN_POSITIONS: Record<number, { x: number; y: number }> = {
  1: { x: WIDTH * 0.50, y: HEIGHT * 0.38 },
  2: { x: WIDTH * 0.25, y: HEIGHT * 0.15 },
  3: { x: WIDTH * 0.17, y: HEIGHT * 0.25 },
  4: { x: WIDTH * 0.41, y: HEIGHT * 0.50 },
  5: { x: WIDTH * 0.17, y: HEIGHT * 0.75 },
  6: { x: WIDTH * 0.25, y: HEIGHT * 0.84 },
  7: { x: WIDTH * 0.50, y: HEIGHT * 0.60 },
  8: { x: WIDTH * 0.75, y: HEIGHT * 0.84 },
  9: { x: WIDTH * 0.83, y: HEIGHT * 0.75 },
 10: { x: WIDTH * 0.59, y: HEIGHT * 0.50 },
 11: { x: WIDTH * 0.83, y: HEIGHT * 0.25 },
 12: { x: WIDTH * 0.75, y: HEIGHT * 0.15 },
};

const PLANET_POSITIONS: Record<number, { x: number; y: number }> = {
  1: { x: WIDTH * 0.50, y: HEIGHT * 0.25 },
  2: { x: WIDTH * 0.25, y: HEIGHT * 0.10 },
  3: { x: WIDTH * 0.07, y: HEIGHT * 0.29 },
  4: { x: WIDTH * 0.25, y: HEIGHT * 0.51 },
  5: { x: WIDTH * 0.07, y: HEIGHT * 0.78 },
  6: { x: WIDTH * 0.25, y: HEIGHT * 0.93 },
  7: { x: WIDTH * 0.50, y: HEIGHT * 0.78 },
  8: { x: WIDTH * 0.75, y: HEIGHT * 0.93 },
  9: { x: WIDTH * 0.92, y: HEIGHT * 0.76 },
 10: { x: WIDTH * 0.75, y: HEIGHT * 0.51 },
 11: { x: WIDTH * 0.92, y: HEIGHT * 0.29 },
 12: { x: WIDTH * 0.75, y: HEIGHT * 0.10 },
};

const TRIANGLE_HOUSES = new Set([3, 5, 9, 11]);

const ASPECT_POSITIONS: Record<number, { x: number; y: number }> = {
  1: { x: WIDTH * 0.50, y: HEIGHT * 0.18 },
  2: { x: WIDTH * 0.25, y: HEIGHT * 0.05 },
  3: { x: WIDTH * 0.07, y: HEIGHT * 0.18 },
  4: { x: WIDTH * 0.25, y: HEIGHT * 0.43 },
  5: { x: WIDTH * 0.07, y: HEIGHT * 0.68 },
  6: { x: WIDTH * 0.25, y: HEIGHT * 0.97 },
  7: { x: WIDTH * 0.50, y: HEIGHT * 0.70 },
  8: { x: WIDTH * 0.75, y: HEIGHT * 0.97 },
  9: { x: WIDTH * 0.92, y: HEIGHT * 0.68 },
 10: { x: WIDTH * 0.75, y: HEIGHT * 0.43 },
 11: { x: WIDTH * 0.92, y: HEIGHT * 0.18 },
 12: { x: WIDTH * 0.75, y: HEIGHT * 0.05 },
};

const NorthIndianChart: FC<NorthIndianChartProps> = ({ title, className, houses, centered = true }) => {
  const baseClass = centered ? "mx-auto w-full max-w-[600px]" : "w-full max-w-[600px]";
  const containerClass = [baseClass, className ?? ""]
    .filter((part) => part.length > 0)
    .join(" ");

  return (
    <div className={containerClass}>
      {title ? (
        <div className="mb-3 text-center text-base font-black uppercase tracking-wide text-white">{title}</div>
      ) : null}
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full rounded-xl border border-white/20 bg-slate-950/80 shadow-lg"
          preserveAspectRatio="xMidYMid meet"
        >
          <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="#0f172a" stroke="rgba(255,255,255,0.65)" strokeWidth={2} />
          {BASE_LINES.map((line, idx) => (
            <line key={`base-${idx}`} {...LINE_STYLE} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
          ))}
          {PARALLEL_TO_DIAG2.map((line, idx) => (
            <line key={`p2-${idx}`} {...LINE_STYLE} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
          ))}
          {PARALLEL_TO_DIAG1.map((line, idx) => (
            <line key={`p1-${idx}`} {...LINE_STYLE} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
          ))}
          {houses?.map((house) => {
            const signPos = SIGN_POSITIONS[house.houseNumber];
            const planetPos = PLANET_POSITIONS[house.houseNumber];
            const aspectPos = ASPECT_POSITIONS[house.houseNumber];
            if (!signPos) return null;
            const planetLabels = house.planetLabels ?? [];
            const isTriangleHouse = TRIANGLE_HOUSES.has(house.houseNumber);
            // Если планета ретроградная, отображать в скобках
            const displayLabels = planetLabels.map((label) => {
              // label может быть типа "Sa" или "Sa*" или "Sa R" — зависит от передачи
              if (label.endsWith(" R") || label.endsWith("*")) {
                return `(${label.replace(/ R|\*/g, "")})`;
              }
              return label;
            });
            const needsSplit = isTriangleHouse && displayLabels.length > 2;
            const firstLine = needsSplit ? displayLabels.slice(0, 2).join(" ") : displayLabels.join(" ");
            const secondLine = needsSplit ? displayLabels.slice(2).join(" ") : "";
            return (
              <g key={`label-${house.houseNumber}`}>
                <text
                  x={signPos.x}
                  y={signPos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#f8fafc"
                  fontSize={20}
                  fontWeight={700}
                >
                  {house.signIndex ?? ""}
                </text>
                {house.signLabel ? (
                  <text
                    x={signPos.x}
                    y={signPos.y + 14}
                    textAnchor="middle"
                    fill="rgba(248,250,252,0.7)"
                    fontSize={12}
                    fontWeight={500}
                  >
                    {house.signLabel}
                  </text>
                ) : null}
                {firstLine && planetPos ? (
                  <text
                    x={planetPos.x}
                    y={planetPos.y}
                    textAnchor="middle"
                    fill="#f8fafc"
                    fontSize={20}
                    fontWeight={600}
                  >
                    {firstLine}
                  </text>
                ) : null}
                {secondLine && planetPos ? (
                  <text
                    x={planetPos.x}
                    y={planetPos.y + 18}
                    textAnchor="middle"
                    fill="#f8fafc"
                    fontSize={20}
                    fontWeight={600}
                  >
                    {secondLine}
                  </text>
                ) : null}
                {house.aspectLabels && house.aspectLabels.length && aspectPos ? (
                  <text
                    x={aspectPos.x}
                    y={aspectPos.y}
                    textAnchor="middle"
                    fill="rgba(148,163,184,0.85)"
                    fontSize={16}
                    fontWeight={500}
                  >
                    {house.aspectLabels.join(" ")}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

export default NorthIndianChart;
