import { useState } from "react";

import { callUi, messageOf } from "./api";

import type { DevicePrompt as Prompt } from "@rujira/connect-core";
import type { ReactElement } from "react";

export function DevicePromptFields({
  prompt,
  value,
  onChange,
  disabled = false,
}: {
  readonly prompt: Prompt;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <div className="device-prompt" role="group" aria-label="Trezor connection">
      <h2>
        {prompt.kind === "pin"
          ? "Unlock your Trezor"
          : prompt.kind === "passphrase"
            ? "Choose your Trezor wallet"
            : "Connect your Trezor"}
      </h2>
      <p>{prompt.message}</p>
      {prompt.kind !== "confirmation" && (
        <label className="field">
          {prompt.kind === "pin"
            ? "PIN grid positions"
            : prompt.kind === "passphrase"
              ? "Wallet passphrase"
              : "Pairing code"}
          <input
            type={prompt.kind === "pairing" ? "text" : "password"}
            autoComplete="off"
            value={value}
            disabled={disabled}
            maxLength={prompt.kind === "pin" ? 50 : 1024}
            pattern={prompt.kind === "pin" ? "[1-9]{1,50}" : undefined}
            required={prompt.kind !== "passphrase"}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </label>
      )}
    </div>
  );
}

export function DevicePrompt({
  prompt,
  onError,
}: {
  readonly prompt: Prompt;
  readonly onError: (message: string) => void;
}): ReactElement {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  function respond(cancel: boolean, onDevice = false): void {
    setSending(true);
    callUi({ action: "deviceResponse", id: prompt.id, value, cancel, onDevice })
      .catch((error: unknown) => {
        onError(messageOf(error));
      })
      .finally(() => {
        setValue("");
        setSending(false);
      })
      .catch(() => undefined);
  }
  return (
    <section className="card device-prompt" aria-label="Trezor connection">
      <DevicePromptFields
        prompt={prompt}
        value={value}
        onChange={setValue}
        disabled={sending}
      />
      <div className="approval-actions">
        <button
          type="button"
          disabled={sending}
          onClick={() => {
            respond(true);
          }}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={
            sending ||
            (prompt.kind === "pin" && !/^[1-9]{1,50}$/.test(value)) ||
            (prompt.kind === "pairing" && !value)
          }
          onClick={() => {
            respond(false);
          }}>
          Continue
        </button>
      </div>
      {prompt.kind === "passphrase" && (
        <button
          type="button"
          className="text-button"
          disabled={sending}
          onClick={() => {
            respond(false, true);
          }}>
          Enter on device
        </button>
      )}
    </section>
  );
}
