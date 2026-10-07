import {
  CHAINS,
  CHAIN_IDS,
  ConnectError,
  ERROR_CODES,
  chainSchema,
  accountIndexError,
  accountIndexLimit,
  accountPath,
  isDefaultAccountPath,
  pendingViewSchema,
  uiStateSchema,
} from "@rujira/connect-core";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { callUi, chooseLedger, chooseTrezor, messageOf } from "./api";
import { DevicePrompt } from "./DevicePrompt";
import { Logo } from "./Logo";
import { NetworkIcon } from "./NetworkIcon";

import type {
  Chain,
  PendingView,
  SourceKind,
  UiState,
} from "@rujira/connect-core";
import type { FormEvent, ReactElement } from "react";

const EMPTY: UiState = { sources: [], accounts: [], grants: [], unlocked: [] };
type Screen = "accounts" | "register" | "sites" | "settings";

export function App(): ReactElement {
  const search = new URLSearchParams(location.search);
  const approvalId = search.get("view") === "approve" ? search.get("id") : null;
  const popup = search.get("view") === "popup";
  const [state, setState] = useState<UiState>(EMPTY);
  const [screen, setScreen] = useState<Screen>("accounts");
  const [pending, setPending] = useState<PendingView | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [acknowledge, setAcknowledge] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [done, setDone] = useState(false);
  const [completion, setCompletion] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("ledger");
  const [sourceId, setSourceId] = useState("");
  const [chain, setChain] = useState<Chain>("THOR");
  const [index, setIndex] = useState("0");
  const [profile, setProfile] = useState<"default" | "legacy" | "evm">(
    "default"
  );
  const [keystore, setKeystore] = useState<Record<string, unknown> | null>(
    null
  );
  const [keystoreLabel, setKeystoreLabel] = useState("My keystore");

  const load = useCallback(async (): Promise<void> => {
    setState(uiStateSchema.parse(await callUi({ action: "state" })));
  }, []);
  useEffect(() => {
    let active = true;
    callUi({ action: "state" })
      .then((value) => {
        if (active) setState(uiStateSchema.parse(value));
      })
      .catch((reason: unknown) => {
        if (active) setError(messageOf(reason));
      });
    if (approvalId)
      callUi({ action: "pending", id: approvalId })
        .then((value) => {
          if (active) setPending(pendingViewSchema.parse(value));
        })
        .catch((reason: unknown) => {
          if (active) setError(messageOf(reason));
        });
    const poll = setInterval(() => {
      callUi({ action: "state" })
        .then((value) => {
          if (active) setState(uiStateSchema.parse(value));
        })
        .catch(() => undefined);
    }, 15_000);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [approvalId]);

  useEffect(() => {
    if (!busy) return;
    const poll = setInterval(() => {
      load().catch(() => undefined);
    }, 500);
    return () => {
      clearInterval(poll);
    };
  }, [busy, load]);

  function perform(task: () => Promise<void>): void {
    setError("");
    setNotice("");
    setBusy(true);
    task()
      .catch((reason: unknown) => {
        setError(messageOf(reason));
      })
      .finally(() => {
        setBusy(false);
        setPassword("");
      })
      .catch(() => {
        /* This best-effort notification has no user-visible result. */
      });
  }
  function changeSource(kind: SourceKind): void {
    if (kind === "ledger" && chain === "XMR") setIndex("0");
    setSourceKind(kind);
    setSourceId("");
    setPassword("");
    setKeystore(null);
    setProfile(kind === "trezor" && chain === "THOR" ? "evm" : "default");
    if (kind === "trezor" && chain === "GAIA") {
      setChain("THOR");
      setProfile("evm");
    }
  }
  function changeChain(next: Chain): void {
    if (next === "XMR" && sourceKind === "ledger") setIndex("0");
    setChain(next);
    setProfile(sourceKind === "trezor" && next === "THOR" ? "evm" : "default");
  }
  function openManager(): void {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("index.html") })
      .catch(() => {
        setError("Could not open account management");
      });
  }
  function addSource(): void {
    if (popup) openManager();
    else setScreen("register");
  }
  function register(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    perform(async () => {
      if (indexError) throw new ConnectError(ERROR_CODES.invalid, indexError);
      if (sourceKind === "ledger") await chooseLedger();
      else if (sourceKind === "trezor") await chooseTrezor();
      await callUi({
        action: "register",
        source: sourceKind,
        ...(sourceId ? { sourceId } : {}),
        chain,
        accountIndex: parsedIndex,
        profile,
      });
      await load();
      setScreen("accounts");
      setNotice(`${CHAINS[chain].name} account added`);
    });
  }
  function approve(): void {
    if (!pending) return;
    const approval = pending;
    perform(async () => {
      await callUi({
        action: "approve",
        id: approval.id,
        digest: approval.digest,
        accountIds: selected,
        acknowledgeRaw: acknowledge,
        ...(password ? { password } : {}),
      });
      setCompletion(
        approval.request.method === "connect"
          ? "Accounts shared"
          : "Request signed"
      );
      setDone(true);
    });
  }
  function reject(): void {
    if (!pending) {
      window.close();
      return;
    }
    perform(async () => {
      await callUi({ action: "reject", id: pending.id });
      setCompletion("Request declined");
      setDone(true);
    });
  }

  const unlocked = state.unlocked.length > 0;
  const signingRequest =
    pending?.request.method === "sign" ? pending.request.params : undefined;
  const signingAccount = state.accounts.find(
    (account) => account.id === signingRequest?.accountId
  );
  const signingSource = signingAccount?.source;
  const needsPassword =
    signingSource === "keystore" &&
    !state.unlocked.some(
      (entry) => entry.sourceId === signingAccount?.sourceId
    );
  const parsedIndex = index.trim() ? Number(index) : Number.NaN;
  const indexError = accountIndexError(chain, sourceKind, parsedIndex);
  const selectedPath = indexError
    ? undefined
    : accountPath(chain, parsedIndex, sourceKind, profile);

  return (
    <div
      className={`app ${popup ? "popup" : ""} ${approvalId ? "approval" : ""}`}>
      <header className="header">
        <a className="brand" href="index.html">
          <Logo />
          <span>
            <strong>RUJIRA</strong>
            <small>CONNECT</small>
          </span>
        </a>
        <a
          className="network-credit"
          href="https://rujira.network/"
          target="_blank"
          rel="noopener noreferrer">
          by Rujira Network
        </a>
      </header>
      <main>
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="message success" role="status">
            {notice}
          </div>
        )}
        {state.devicePrompt && (
          <DevicePrompt
            key={state.devicePrompt.id}
            prompt={state.devicePrompt}
            onError={setError}
          />
        )}
        {approvalId ? (
          done ? (
            <section className="empty">
              <Logo large />
              <h1>{completion}</h1>
              <p>You can go back to the app now.</p>
              <button
                className="primary"
                onClick={() => {
                  window.close();
                }}>
                Close
              </button>
            </section>
          ) : (
            <section className="approval-content">
              <div className="eyebrow">REQUEST FROM</div>
              <div className="origin">
                {pending?.origin ?? "Loading request…"}
              </div>
              <h1>
                {pending?.request.method === "connect"
                  ? "Share your addresses"
                  : (pending?.review?.title ?? "Review the request")}
              </h1>
              {pending?.request.method === "connect" ? (
                <>
                  <p>
                    Choose which accounts to share with this site. You'll still
                    approve each signing request.
                  </p>
                  <div className="account-list">
                    {pending.accounts.map((account) => (
                      <label
                        className="account selectable"
                        key={account.id}
                        htmlFor={`account-${account.id}`}>
                        <input
                          id={`account-${account.id}`}
                          aria-label={`${CHAINS[account.chain].name} ${account.label}`}
                          type="checkbox"
                          checked={selected.includes(account.id)}
                          onChange={(event) => {
                            setSelected(
                              event.target.checked
                                ? [...selected, account.id]
                                : selected.filter((id) => id !== account.id)
                            );
                          }}
                        />
                        <NetworkIcon chain={account.chain} />
                        <span className="account-body">
                          <strong>{CHAINS[account.chain].name}</strong>
                          <small>{account.label}</small>
                          <code>{account.address}</code>
                          {!isDefaultAccountPath(account) && (
                            <small className="account-path">
                              HD path <code>{account.path}</code>
                            </small>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                  {pending.accounts.length === 0 && (
                    <div className="card">
                      <p>
                        You haven't added an account for the network this app
                        needs.
                      </p>
                      <button onClick={openManager}>Add an account</button>
                      <p className="muted">
                        Once you've added one, go back to the app and connect
                        again.
                      </p>
                    </div>
                  )}
                </>
              ) : (
                pending?.review && (
                  <>
                    {signingAccount && (
                      <div className="request-network">
                        <NetworkIcon chain={signingAccount.chain} />
                        <span>{CHAINS[signingAccount.chain].name}</span>
                      </div>
                    )}
                    <dl className="review-fields">
                      {pending.review.fields.map((field, fieldIndex) => (
                        <div key={`${field.label}-${String(fieldIndex)}`}>
                          <dt>{field.label}</dt>
                          <dd>{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                    <details className="raw">
                      <summary>See the full request</summary>
                      <pre>
                        {JSON.stringify(
                          JSON.parse(pending.review.raw) as unknown,
                          null,
                          2
                        )}
                      </pre>
                    </details>
                    {pending.review.requiresRawAcknowledgement && (
                      <label className="ack">
                        <input
                          type="checkbox"
                          checked={acknowledge}
                          onChange={(event) => {
                            setAcknowledge(event.target.checked);
                          }}
                        />
                        <span>
                          I've checked the full request. This summary doesn't
                          show every instruction.
                        </span>
                      </label>
                    )}
                    <p className="muted">
                      {signingSource === "keystore"
                        ? "Your keystore signs on this computer."
                        : "Check and confirm the request on your device."}{" "}
                      Rujira Connect returns the signed request to the app.
                    </p>
                    {needsPassword && (
                      <label className="field">
                        Keystore password
                        <input
                          type="password"
                          value={password}
                          autoComplete="off"
                          onChange={(event) => {
                            setPassword(event.target.value);
                          }}
                        />
                      </label>
                    )}
                  </>
                )
              )}
              <div className="approval-actions">
                <button disabled={busy} onClick={reject}>
                  Decline
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !pending ||
                    (pending.request.method === "connect" &&
                      selected.length === 0) ||
                    ((pending.review?.requiresRawAcknowledgement ?? false) &&
                      !acknowledge) ||
                    (needsPassword && !password)
                  }
                  onClick={approve}>
                  {busy
                    ? pending?.request.method === "connect"
                      ? "Sharing accounts…"
                      : signingSource === "keystore"
                        ? "Signing…"
                        : "Check your device…"
                    : pending?.request.method === "connect"
                      ? "Connect"
                      : "Sign"}
                </button>
              </div>
            </section>
          )
        ) : (
          <>
            {state.sources.some((source) => source.kind === "keystore") && (
              <div className="toolbar">
                <span className={`status ${unlocked ? "unlocked" : ""}`}>
                  <i />
                  {unlocked ? "Keystore unlocked" : "Keystores locked"}
                </span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    perform(async () => {
                      await callUi({ action: "lock" });
                      await load();
                    });
                  }}>
                  Lock
                </button>
              </div>
            )}
            <nav className="tabs" aria-label="Account management">
              {(["accounts", "sites", "settings"] as const).map((item) => (
                <button
                  key={item}
                  aria-current={screen === item ? "page" : undefined}
                  onClick={() => {
                    if (popup && item !== "accounts") openManager();
                    else setScreen(item);
                  }}>
                  {item[0]?.toUpperCase()}
                  {item.slice(1)}
                </button>
              ))}
            </nav>
            {screen === "accounts" && (
              <>
                <div className="section-heading">
                  <div>
                    <h1>Your accounts</h1>
                    <p className="muted">
                      Connect your hardware wallet directly and sign requests
                      from apps.
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Add an account"
                    onClick={addSource}>
                    +
                  </button>
                </div>
                {state.accounts.length === 0 ? (
                  <section className="empty">
                    <Logo large />
                    <h2>Add your first account</h2>
                    <p>
                      Plug in your Ledger or Trezor to read an address and
                      confirm it on the device. You can also use an encrypted
                      keystore.
                    </p>
                    <button className="primary" onClick={addSource}>
                      Add an account
                    </button>
                  </section>
                ) : (
                  <>
                    <div className="account-list">
                      {state.accounts.map((account) => {
                        const source = state.sources.find(
                          (entry) => entry.id === account.sourceId
                        );
                        return (
                          <article className="account" key={account.id}>
                            <NetworkIcon chain={account.chain} />
                            <div className="account-body">
                              <strong>
                                {source?.deviceName ??
                                  source?.label ??
                                  account.label}
                                {!isDefaultAccountPath(account) && (
                                  <>
                                    {" "}
                                    ·{" "}
                                    <code className="account-path">
                                      {account.path}
                                    </code>
                                  </>
                                )}
                              </strong>
                              <div className="account-address">
                                <code>{account.address}</code>
                              </div>
                            </div>
                            <div className="account-actions">
                              <button
                                className="icon-button"
                                title="Copy address"
                                aria-label={`Copy ${CHAINS[account.chain].name} address`}
                                onClick={() => {
                                  navigator.clipboard
                                    .writeText(account.address)
                                    .then(() => {
                                      setNotice("Address copied");
                                    })
                                    .catch(() => {
                                      setError("Could not copy address");
                                    });
                                }}>
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  aria-hidden="true">
                                  <rect
                                    x="8"
                                    y="8"
                                    width="12"
                                    height="12"
                                    rx="2"
                                  />
                                  <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                                </svg>
                              </button>
                              <button
                                className="icon-button remove-account"
                                title="Remove account"
                                disabled={busy}
                                aria-label={`Remove ${account.label} account`}
                                onClick={() => {
                                  perform(async () => {
                                    await callUi({
                                      action: "removeAccount",
                                      accountId: account.id,
                                    });
                                    await load();
                                    setNotice(
                                      `${CHAINS[account.chain].name} account removed`
                                    );
                                  });
                                }}>
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  aria-hidden="true">
                                  <path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" />
                                </svg>
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    <button className="add-account" onClick={addSource}>
                      + Add another account
                    </button>
                  </>
                )}
                {state.accounts.length > 0 && (
                  <p className="muted">
                    Removing an account also removes its access from connected
                    sites. You can add it again whenever you need it.
                  </p>
                )}
              </>
            )}
            {screen === "register" && (
              <section>
                <button
                  className="text-button back"
                  onClick={() => {
                    setScreen("accounts");
                  }}>
                  ← Accounts
                </button>
                <h1>Add an account</h1>
                <p>
                  Choose your wallet and network. Connect reads your address
                  locally so you can share it with apps and sign their requests.
                </p>
                <div className="source-options">
                  {(["ledger", "trezor", "keystore"] as const).map((kind) => (
                    <button
                      key={kind}
                      aria-pressed={sourceKind === kind}
                      onClick={() => {
                        changeSource(kind);
                      }}>
                      {kind === "keystore"
                        ? "Keystore"
                        : kind === "ledger"
                          ? "Ledger"
                          : "Trezor"}
                    </button>
                  ))}
                </div>
                {sourceKind === "trezor" && (
                  <p className="hint">
                    Plug in your Trezor and choose it in the USB window. Unlock
                    it when asked.
                  </p>
                )}
                {sourceKind === "keystore" && (
                  <div className="card">
                    <label className="field">
                      Encrypted keystore
                      <input
                        type="file"
                        accept=".json,application/json"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          perform(async () => {
                            if (file.size > 16_384)
                              throw new Error("Keystore is too large");
                            const value: unknown = JSON.parse(
                              await file.text()
                            );
                            setKeystore(z.record(z.unknown()).parse(value));
                          });
                        }}
                      />
                    </label>
                    <label className="field">
                      Name
                      <input
                        value={keystoreLabel}
                        maxLength={80}
                        onChange={(event) => {
                          setKeystoreLabel(event.target.value);
                        }}
                      />
                    </label>
                    <label className="field">
                      Keystore password
                      <input
                        type="password"
                        autoComplete="off"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                        }}
                      />
                    </label>
                    <button
                      disabled={!keystore || !password || busy}
                      onClick={() => {
                        perform(async () => {
                          if (!keystore) return;
                          await callUi({
                            action: "import",
                            label: keystoreLabel,
                            keystore,
                            password,
                          });
                          setKeystore(null);
                          await load();
                          setNotice(
                            "Keystore imported. Choose it below to add an account."
                          );
                        });
                      }}>
                      Import keystore
                    </button>
                    <p className="muted">
                      Open a THORChain or XChain keystore file to sign on this
                      computer. It locks again after five minutes.
                    </p>
                  </div>
                )}
                <form onSubmit={register}>
                  <label className="field">
                    {sourceKind === "keystore" ? "Imported keystore" : "Device"}
                    <select
                      value={sourceId}
                      onChange={(event) => {
                        setSourceId(event.target.value);
                      }}>
                      {sourceKind !== "keystore" ? (
                        <option value="">
                          Connect another{" "}
                          {sourceKind === "ledger" ? "Ledger" : "Trezor"}
                        </option>
                      ) : (
                        <option value="">Choose your keystore</option>
                      )}
                      {state.sources
                        .filter((source) => source.kind === sourceKind)
                        .map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="network-label">
                      <NetworkIcon chain={chain} /> Network
                    </span>
                    <select
                      value={chain}
                      onChange={(event) => {
                        changeChain(chainSchema.parse(event.target.value));
                      }}>
                      {CHAIN_IDS.filter(
                        (id) => sourceKind !== "trezor" || id !== "GAIA"
                      ).map((id) => (
                        <option key={id} value={id}>
                          {CHAINS[id].name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="form-row">
                    {!(chain === "XMR" && sourceKind === "ledger") && (
                      <label className="field">
                        Account index
                        <input
                          type="number"
                          min={0}
                          max={accountIndexLimit(chain, sourceKind)}
                          step={1}
                          required
                          aria-invalid={Boolean(indexError)}
                          aria-describedby="account-index-help"
                          value={index}
                          onChange={(event) => {
                            setIndex(event.target.value);
                          }}
                        />
                      </label>
                    )}
                    {((chain === "THOR" && sourceKind !== "keystore") ||
                      chain === "BTC" ||
                      chain === "LTC") && (
                      <label className="field">
                        Address type
                        <select
                          value={profile}
                          onChange={(event) => {
                            setProfile(
                              z
                                .enum(["default", "legacy", "evm"])
                                .parse(event.target.value)
                            );
                          }}>
                          {chain === "THOR" ? (
                            <>
                              {sourceKind === "ledger" && (
                                <option value="default">THORChain app</option>
                              )}
                              <option value="evm">Ethereum app</option>
                            </>
                          ) : (
                            <>
                              <option value="default">Native SegWit</option>
                              <option value="legacy">Legacy</option>
                            </>
                          )}
                        </select>
                      </label>
                    )}
                  </div>
                  <p
                    id="account-index-help"
                    className={indexError ? "validation-error" : "muted"}>
                    {indexError ??
                      (chain === "BTC" && sourceKind === "ledger"
                        ? "Use 0 for your first account. Bitcoin on Ledger supports indexes 0–100."
                        : chain === "XMR" && sourceKind === "ledger"
                          ? "Connect uses the wallet selected in the Monero app on your Ledger."
                          : "Use 0 for your first account, 1 for your second, and so on.")}
                  </p>
                  {selectedPath &&
                    !isDefaultAccountPath({
                      chain,
                      source: sourceKind,
                      path: selectedPath,
                    }) && (
                      <p className="path-preview muted">
                        HD path <code>{selectedPath}</code>
                      </p>
                    )}
                  {sourceKind === "keystore" &&
                    sourceId &&
                    !state.unlocked.some(
                      (entry) => entry.sourceId === sourceId
                    ) && (
                      <div className="card">
                        <label className="field">
                          Keystore password
                          <input
                            type="password"
                            value={password}
                            autoComplete="off"
                            onChange={(event) => {
                              setPassword(event.target.value);
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={!password || busy}
                          onClick={() => {
                            perform(async () => {
                              await callUi({
                                action: "unlock",
                                sourceId,
                                password,
                              });
                              await load();
                            });
                          }}>
                          Unlock keystore
                        </button>
                      </div>
                    )}
                  <button
                    className="primary full"
                    type="submit"
                    disabled={
                      busy ||
                      Boolean(indexError) ||
                      (sourceKind === "keystore" &&
                        (!sourceId ||
                          !state.unlocked.some(
                            (entry) => entry.sourceId === sourceId
                          )))
                    }>
                    {busy
                      ? sourceKind === "keystore"
                        ? "Adding account…"
                        : "Check your device…"
                      : sourceKind === "ledger"
                        ? "Choose Ledger and add account"
                        : "Add account"}
                  </button>
                  {sourceKind === "ledger" && (
                    <p className="muted">
                      {chain === "XMR"
                        ? "Open the Monero app and confirm your address on the device."
                        : `Open the ${chain === "THOR" && profile === "evm" ? "Ethereum" : CHAINS[chain].app} app on your device when asked.`}
                    </p>
                  )}
                </form>
              </section>
            )}
            {screen === "sites" && (
              <section>
                <h1>Connected sites</h1>
                <p>
                  These sites can see the accounts you've shared with them.
                  Disconnect a site to remove its access.
                </p>
                {state.grants.length === 0 ? (
                  <div className="card muted">No sites have access yet.</div>
                ) : (
                  state.grants.map((grant) => (
                    <article className="card site" key={grant.origin}>
                      <strong>{grant.origin}</strong>
                      <p className="muted">
                        {String(grant.accountIds.length)} approved account
                        {grant.accountIds.length === 1 ? "" : "s"}
                      </p>
                      <button
                        disabled={busy}
                        onClick={() => {
                          perform(async () => {
                            await callUi({
                              action: "revoke",
                              origin: grant.origin,
                            });
                            await load();
                          });
                        }}>
                        Disconnect
                      </button>
                    </article>
                  ))
                )}
              </section>
            )}
            {screen === "settings" && (
              <section>
                <h1>Your wallets</h1>
                <p>
                  Removing a wallet removes all its accounts from Rujira Connect
                  and disconnects them from sites.
                </p>
                {state.sources.map((source) => (
                  <article className="card source" key={source.id}>
                    <div>
                      <strong>
                        {source.deviceName ?? source.label}
                        {source.kind !== "keystore" && (
                          <>
                            {" "}
                            · <code>{source.id.slice(0, 8)}</code>
                          </>
                        )}
                      </strong>
                      <small>
                        {source.kind === "keystore"
                          ? "Encrypted keystore"
                          : "Hardware wallet"}
                      </small>
                    </div>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        perform(async () => {
                          await callUi({
                            action: "forget",
                            sourceId: source.id,
                          });
                          await load();
                        });
                      }}>
                      Remove
                    </button>
                  </article>
                ))}
                {state.accounts.some((account) => account.chain === "XMR") && (
                  <div className="card">
                    <h2>Monero</h2>
                    <p>
                      Monero addresses connect directly. Apps find spendable
                      outputs, choose ring members, and calculate fees. Connect
                      signs locally and returns the transaction to the app.
                    </p>
                    <p className="muted">
                      Transfers support one recipient and change, using Ledger,
                      Trezor or an unlocked keystore. Your app prepares the
                      transaction and sends it after signing.
                    </p>
                  </div>
                )}
                <div className="card">
                  <h2>How Connect works</h2>
                  <p>
                    Connect reads addresses and signs requests locally. Your
                    apps prepare transactions and handle the network connection.
                  </p>
                  <p className="muted">
                    Connect doesn't fetch balances or make RPC requests. This
                    includes Monero: your app supplies the data needed to sign
                    and broadcasts the result.
                  </p>
                </div>
                <p className="muted">Rujira Connect · v0.1.0</p>
              </section>
            )}
          </>
        )}
      </main>
      <footer>
        <span>RUJIRA CONNECT</span>
        <span>v0.1.0</span>
      </footer>
    </div>
  );
}
