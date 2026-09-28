/** Room delivery policy. Persisted eligibility on existing deliveries is not reset by edits. */
export interface DeliverySettings {
  deliveryHoldMs: number;
  batchHeld: boolean;
  batchMaxHoldMs: number;
}

/** null removes the saved key; omission leaves it unchanged. */
export type DeliverySettingsPatch = {
  [K in keyof DeliverySettings]?: DeliverySettings[K] | null;
};

export interface RoomSettingsView {
  defaults: DeliverySettings;
  /** Defaults merged with the room file, before environment overrides. */
  configured: DeliverySettings;
  effective: DeliverySettings;
  /** Edits to these keys are saved, but do not change their effective values. */
  overridden: Array<keyof DeliverySettings>;
}
