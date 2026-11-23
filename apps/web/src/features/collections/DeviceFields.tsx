import {
  deviceFields,
  deviceFieldLabels,
  type DeviceCategory,
} from "../../../../../packages/contracts/device-collection";
export function DeviceFields({ category }: { category: DeviceCategory }) {
  return (
    <fieldset className="collect-device-fields">
      <legend>设备资料 · 未知项留空</legend>
      <div className="collect-fields">
        {deviceFields(category).map((field) => (
          <label key={field}>
            {deviceFieldLabels[field]}
            <input
              name={`device.${field}`}
              type={field === "supportUntil" ? "date" : "text"}
              maxLength={2000}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
