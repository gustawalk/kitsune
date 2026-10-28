import { Check } from "lucide-react";
import type { CSSProperties } from "react";

const colors = [
  ["Coral", "#e85d3f"],
  ["Amber", "#d5ad67"],
  ["Green", "#81bd93"],
  ["Blue", "#69b7d4"],
  ["Purple", "#b69ae8"],
  ["Pink", "#dc8cb6"],
] as const;

export function ConnectionColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <fieldset className="connection-color-field">
      <legend>Connection color</legend>
      <div className="connection-color-options">
        <button
          type="button"
          className="connection-color-default"
          aria-pressed={!value}
          onClick={() => onChange("")}
        >
          Default
        </button>
        {colors.map(([name, color]) => (
          <button
            type="button"
            key={color}
            className="connection-color-swatch"
            style={{ "--swatch-color": color } as CSSProperties}
            aria-label={`${name} connection color`}
            aria-pressed={value.toLowerCase() === color}
            title={name}
            onClick={() => onChange(color)}
          >
            {value.toLowerCase() === color && <Check size={13} />}
          </button>
        ))}
        <label className="connection-color-custom">
          <input
            type="color"
            aria-label="Custom connection color"
            value={value || "#e85d3f"}
            onChange={(event) => onChange(event.target.value)}
          />
          <span>Custom</span>
        </label>
      </div>
    </fieldset>
  );
}
