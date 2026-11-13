import { memo } from "react";
import { Panel, useReactFlow, useStore, useViewport } from "@xyflow/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import FitToScreenIcon from "@hugeicons/core-free-icons/FitToScreenIcon";

/**
 * The board's own zoom control, replacing React Flow's default button stack.
 *
 * It reads the live viewport, so the percentage is the same number the transform
 * is using; the fit button carries `data-canvas="fit"` because the verification
 * script presses it through the DOM — pressing the board anywhere else would pan.
 * The slider is hidden on phones, where the buttons alone fit a narrow strip.
 */

function ZoomButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: IconSvgElement;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.7} />
    </button>
  );
}

function ZoomControls() {
  const { zoom } = useViewport();
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);

  return (
    <Panel
      position="top-right"
      className="!m-3 flex items-center gap-1 rounded-full border border-border bg-card/95 p-1 shadow-card backdrop-blur"
    >
      <ZoomButton
        label="Zoom out"
        icon={MinusSignIcon}
        disabled={zoom <= minZoom}
        onClick={() => void zoomOut({ duration: 140 })}
      />
      <input
        type="range"
        aria-label="Canvas zoom"
        className="hidden w-24 sm:block"
        min={minZoom}
        max={maxZoom}
        step={0.01}
        value={zoom}
        onChange={(event) => void zoomTo(Number(event.target.value), { duration: 0 })}
      />
      <button
        type="button"
        title="Reset to actual size"
        onClick={() => void zoomTo(1, { duration: 140 })}
        className="min-w-[42px] rounded-full px-1.5 py-1 font-mono text-[11px] tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {Math.round(zoom * 100)}%
      </button>
      <ZoomButton
        label="Zoom in"
        icon={Add01Icon}
        disabled={zoom >= maxZoom}
        onClick={() => void zoomIn({ duration: 140 })}
      />
      <button
        type="button"
        data-canvas="fit"
        aria-label="Fit view"
        title="Fit the whole graph on screen"
        onClick={() => void fitView({ padding: 0.18, duration: 240 })}
        className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <HugeiconsIcon icon={FitToScreenIcon} size={14} strokeWidth={1.7} />
      </button>
    </Panel>
  );
}

export const ZoomSlider = memo(ZoomControls);
