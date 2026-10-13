import { createServer } from "node:http";
import { handleCheckout } from "./routes/checkout.ts";

const port = Number(process.env.PORT ?? 8080);

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/checkout") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const result = await handleCheckout(JSON.parse(raw));
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        message: "Unhandled exception in checkout handler",
        stack_trace: (error as Error).stack,
      }),
    );
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  }
}).listen(port, () => console.log(`checkout-api listening on ${port}`));
