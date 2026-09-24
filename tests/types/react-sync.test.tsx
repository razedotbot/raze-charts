// W1B-24 type contract: React handles join viewport groups, charts accept
// viewportGroup/syncId, and ResponsiveContainer takes any component element or
// a render function child.
import {
  Chart,
  Line,
  LineChart,
  ResponsiveContainer,
  createViewportGroup,
  defineChart,
  line,
  type ReactChartHandle,
  type ResponsiveContainerSize,
  type ViewportGroup,
} from "../../src/react";

const group: ViewportGroup = createViewportGroup();
const definition = defineChart({ marks: [line([{ x: 0, y: 1 }], { x: "x", y: "y" })] });
const rows = [{ name: "a", value: 1 }];

// The acceptance case of react-viewport-group-unusable: this was TS2345.
const joinsGroup = (
  <Chart
    definition={definition}
    onReady={(handle) => {
      const leave: () => void = group.add(handle);
      void leave;
    }}
  />
);
void joinsGroup;

const handleContract = (handle: ReactChartHandle): void => {
  handle.setViewport({ x: [0, 1] });
  handle.setViewport(null);
  const current = handle.getViewport();
  void current?.x;
};
void handleContract;

const groupedCharts = (
  <>
    <LineChart data={rows} viewportGroup={group}>
      <Line dataKey="value" />
    </LineChart>
    <LineChart data={rows} syncId="dashboard">
      <Line dataKey="value" />
    </LineChart>
    <Chart definition={definition} syncId="dashboard" onViewportChange={(viewport) => void viewport.x} />
  </>
);
void groupedCharts;

// @ts-expect-error syncId is a string id, not a group.
const invalidSyncId = <LineChart data={rows} syncId={group} />;
void invalidSyncId;

function RevenueChart({ width, height }: { width?: number; height?: number }) {
  return <LineChart data={rows} width={width} height={height} />;
}

const wrapperChild = (
  <ResponsiveContainer height={200}>
    <RevenueChart />
  </ResponsiveContainer>
);
void wrapperChild;

const renderPropChild = (
  <ResponsiveContainer height={200}>
    {({ width, height }: ResponsiveContainerSize) => {
      const numericWidth: number = width;
      const numericHeight: number = height;
      return <LineChart data={rows} width={numericWidth} height={numericHeight} />;
    }}
  </ResponsiveContainer>
);
void renderPropChild;
