import {
  ConnectError,
  ERROR_CODES,
  REQUEST_TIMEOUT_MS,
  authorizeSign,
  authorizedAccounts,
  payloadDigest,
  publicAccount,
} from "@rujira/connect-core";

import type {
  Account,
  PendingView,
  PublicRequest,
  SignRequest,
  StoredState,
} from "@rujira/connect-core";

export interface RequestContext {
  readonly origin: string;
  readonly documentId: string;
  readonly current: () => Promise<boolean>;
}
export interface StateRepository {
  load(): Promise<StoredState>;
  update(change: (state: StoredState) => StoredState): Promise<StoredState>;
}
export interface SigningDriver {
  sign(
    account: Account,
    request: SignRequest,
    digest: string,
    password?: string
  ): Promise<unknown>;
  review(
    account: Account,
    request: SignRequest
  ): NonNullable<PendingView["review"]>;
}
export interface BrokerPlatform {
  openApproval(id: string): Promise<number>;
  changed(origin: string): Promise<void>;
}

interface Pending {
  readonly view: PendingView;
  readonly context: RequestContext;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  windowId?: number;
  approving: boolean;
}

export class RequestBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly rates = new Map<string, { count: number; since: number }>();
  constructor(
    private readonly repository: StateRepository,
    private readonly driver: SigningDriver,
    private readonly platform: BrokerPlatform,
    private readonly now: () => number = Date.now
  ) {}

  async request(
    request: PublicRequest,
    context: RequestContext
  ): Promise<unknown> {
    this.rateLimit(context.origin);
    if (!(await context.current()))
      throw new ConnectError(
        ERROR_CODES.disconnected,
        "The requesting page is no longer active"
      );
    const state = await this.repository.load();
    const accounts = authorizedAccounts(
      context.origin,
      state.accounts,
      state.grants
    );
    switch (request.method) {
      case "getAccounts":
        return accounts.map(publicAccount);
      case "getCapabilities":
        return {
          version: 1,
          signingOnly: true,
          accounts: accounts.map((account) => ({
            accountId: account.id,
            chain: account.chain,
            source: account.source,
            scheme: account.scheme,
            methods: account.methods,
          })),
        };
      case "disconnect":
        await this.repository.update((state) => ({
          ...state,
          grants: state.grants.filter(
            (grant) => grant.origin !== context.origin
          ),
        }));
        await this.platform.changed(context.origin);
        return null;
      case "connect":
        return this.ask(
          request,
          context,
          state.accounts.filter((account) =>
            request.params.chains.includes(account.chain)
          )
        );
      case "sign": {
        const account = authorizeSign(
          context.origin,
          request.params,
          state.accounts,
          state.grants
        );
        return this.ask(
          request,
          context,
          [account],
          this.driver.review(account, request.params)
        );
      }
    }
  }

  private rateLimit(origin: string): void {
    const now = this.now();
    for (const [key, rate] of this.rates)
      if (now - rate.since >= 60_000) this.rates.delete(key);
    const rate = this.rates.get(origin) ?? { count: 0, since: now };
    if (++rate.count > 30)
      throw new ConnectError(
        ERROR_CODES.busy,
        "Too many requests; wait before trying again"
      );
    if (this.rates.size > 1000)
      throw new ConnectError(ERROR_CODES.busy, "Too many connected sites");
    this.rates.set(origin, rate);
  }

  private async ask(
    request: PublicRequest,
    context: RequestContext,
    accounts: Account[],
    review?: PendingView["review"]
  ): Promise<unknown> {
    if (this.pending.size)
      throw new ConnectError(
        ERROR_CODES.busy,
        "Finish the current approval before starting another request"
      );
    const id = crypto.randomUUID();
    const digest = await payloadDigest(request);
    // Recheck after hashing: simultaneous requests must not both open approval windows.
    if (this.pending.size)
      throw new ConnectError(
        ERROR_CODES.busy,
        "Another request is awaiting approval"
      );
    const view: PendingView = {
      id,
      origin: context.origin,
      request,
      digest,
      expiresAt: this.now() + REQUEST_TIMEOUT_MS,
      accounts: accounts.map((account) => ({
        id: account.id,
        chain: account.chain,
        address: account.address,
        label: account.label,
        source: account.source,
        scheme: account.scheme,
        path: account.path,
      })),
      ...(review === undefined ? {} : { review }),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reject(
          id,
          new ConnectError(ERROR_CODES.expired, "The signing request expired")
        );
      }, REQUEST_TIMEOUT_MS);
      const pending: Pending = {
        view,
        context,
        resolve,
        reject,
        timer,
        approving: false,
      };
      this.pending.set(id, pending);
      this.platform
        .openApproval(id)
        .then((windowId) => {
          pending.windowId = windowId;
        })
        .catch(() => {
          this.reject(
            id,
            new ConnectError(
              ERROR_CODES.internal,
              "Could not open an approval window"
            )
          );
        });
    });
  }

  view(id: string): PendingView {
    const pending = this.pending.get(id);
    if (!pending || pending.view.expiresAt <= this.now())
      throw new ConnectError(ERROR_CODES.expired, "This approval has expired");
    return structuredClone(pending.view);
  }

  async approve(
    id: string,
    digest: string,
    accountIds: string[],
    acknowledgeRaw: boolean,
    password?: string
  ): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.approving)
      throw new ConnectError(
        ERROR_CODES.expired,
        "This approval was already completed"
      );
    pending.approving = true;
    try {
      if (
        pending.view.expiresAt <= this.now() ||
        !(await pending.context.current())
      )
        throw new ConnectError(
          ERROR_CODES.expired,
          "The requesting page changed or the approval expired"
        );
      if (
        pending.view.digest !== digest ||
        (await payloadDigest(pending.view.request)) !== digest
      )
        throw new ConnectError(
          ERROR_CODES.invalid,
          "The approval does not match the displayed request"
        );
      const state = await this.repository.load();
      const request = pending.view.request;
      let result: unknown;
      if (request.method === "connect") {
        const allowed = state.accounts.filter(
          (account) =>
            request.params.chains.includes(account.chain) &&
            pending.view.accounts.some((entry) => entry.id === account.id)
        );
        if (
          !accountIds.length ||
          new Set(accountIds).size !== accountIds.length ||
          accountIds.some(
            (accountId) => !allowed.some((account) => account.id === accountId)
          )
        )
          throw new ConnectError(
            ERROR_CODES.invalid,
            "Select registered accounts from this approval"
          );
        const accounts = allowed.filter((account) =>
          accountIds.includes(account.id)
        );
        await this.repository.update((current) => {
          if (
            accountIds.some(
              (accountId) =>
                !current.accounts.some((account) => account.id === accountId)
            )
          )
            throw new ConnectError(
              ERROR_CODES.unauthorized,
              "An account was removed during approval"
            );
          return {
            ...current,
            grants: [
              ...current.grants.filter(
                (grant) => grant.origin !== pending.context.origin
              ),
              {
                origin: pending.context.origin,
                accountIds,
                createdAt: this.now(),
              },
            ],
          };
        });
        await this.platform.changed(pending.context.origin);
        result = accounts.map(publicAccount);
      } else if (request.method === "sign") {
        if (pending.view.review?.requiresRawAcknowledgement && !acknowledgeRaw)
          throw new ConnectError(
            ERROR_CODES.invalid,
            "Acknowledge the raw transaction details before signing"
          );
        const account = authorizeSign(
          pending.context.origin,
          request.params,
          state.accounts,
          state.grants
        );
        const payload = await this.driver.sign(
          account,
          request.params,
          digest,
          password
        );
        if (
          !this.pending.has(id) ||
          this.now() >= pending.view.expiresAt ||
          !(await pending.context.current())
        )
          throw new ConnectError(
            ERROR_CODES.expired,
            "The signing approval expired or the page changed"
          );
        const current = await this.repository.load();
        authorizeSign(
          pending.context.origin,
          request.params,
          current.accounts,
          current.grants
        );
        result = {
          accountId: account.id,
          chain: account.chain,
          method: request.params.method,
          payload,
        };
      } else
        throw new ConnectError(
          ERROR_CODES.invalid,
          "This request does not need approval"
        );
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(result);
    } catch (error) {
      this.reject(
        id,
        error instanceof ConnectError
          ? error
          : new ConnectError(
              ERROR_CODES.internal,
              "The signature could not be completed. Check your source and try again."
            )
      );
      throw error;
    }
  }

  reject(
    id: string,
    error = new ConnectError(
      ERROR_CODES.rejected,
      "The user declined the request"
    )
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }
  windowClosed(windowId: number): void {
    for (const [id, pending] of this.pending)
      if (pending.windowId === windowId) this.reject(id);
  }
  documentClosed(documentId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.context.documentId === documentId)
        this.reject(
          id,
          new ConnectError(
            ERROR_CODES.disconnected,
            "The requesting page disconnected"
          )
        );
  }
  cancelAll(): void {
    for (const id of this.pending.keys())
      this.reject(
        id,
        new ConnectError(ERROR_CODES.locked, "Rujira Connect was locked")
      );
  }
  accountRemoved(accountId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.view.accounts.some((account) => account.id === accountId))
        this.reject(
          id,
          new ConnectError(
            ERROR_CODES.unauthorized,
            "An account in this request was removed. Connect to the app again to choose another account."
          )
        );
  }
}
