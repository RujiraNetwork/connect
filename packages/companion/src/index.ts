import { resolve } from "node:path";

import { companionRequestSchema, serializeError } from "@rujira/connect-core";
import { z } from "zod";

import { loadEngineConfig } from "./engine";
import { NativeMessageDecoder, encodeNativeMessage } from "./framing";
import { CompanionService } from "./service";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  const origin = args.find((argument) =>
    argument.startsWith("chrome-extension://")
  );
  if (!configPath || !origin)
    throw new Error(
      "Launch this companion through the registered browser extension"
    );
  const config = await loadEngineConfig(resolve(configPath));
  if (origin !== `chrome-extension://${config.extensionId}/`)
    throw new Error("Unapproved native messaging origin");
  const service = new CompanionService(config);
  const decoder = new NativeMessageDecoder();
  const shutdown = (): void => {
    service
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid native input");
    for (const message of decoder.feed(chunk)) {
      const identity = z.object({ id: z.string().uuid() }).safeParse(message);
      if (!identity.success) throw new Error("Invalid native request identity");
      try {
        const request = companionRequestSchema.parse(message);
        const result = await service.request(request);
        process.stdout.write(
          encodeNativeMessage({ id: request.id, ok: true, result })
        );
      } catch (error) {
        process.stdout.write(
          encodeNativeMessage({
            id: identity.data.id,
            ok: false,
            error: serializeError(error),
          })
        );
      }
    }
  }
  decoder.finish();
  await service.close();
}

main().catch(() => {
  process.stderr.write("Rujira companion could not complete its request.\n");
  process.exitCode = 1;
});
