import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { configureLocalAgentAccess } from "./http-access.mjs";
import { PRINT_TONE_PROFILE, discoverPrinter, pngToEscPos, writeDirectUsb } from "./printer.mjs";

const port = Number(process.env.PRINT_AGENT_PORT ?? 3421);
const jobDirectory = path.resolve(process.env.PRINT_JOB_DIRECTORY ?? "print-agent/jobs");
const printCommand = process.env.JK5802_PRINT_COMMAND;
const printArguments = process.env.JK5802_PRINT_ARGS ? JSON.parse(process.env.JK5802_PRINT_ARGS) : ["{file}"];
const allowQueueOnly = process.env.ALLOW_PRINT_QUEUE === "true";

const app = express();
app.disable("x-powered-by");
configureLocalAgentAccess(app);
app.use(express.json({ limit: "18mb" }));

function runPrintCommand(filePath) {
  if (!printCommand) return null;
  const args = printArguments.map((argument) => String(argument).replaceAll("{file}", filePath));
  return new Promise((resolve, reject) => {
    const child = spawn(printCommand, args, { windowsHide: true, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve("printed") : reject(new Error(`Printer command exited with code ${code}.`)));
  });
}

app.get("/health", async (_request, response) => {
  const printer = await discoverPrinter();
  response.json({ ok: true, agent: "online", toneProfile: PRINT_TONE_PROFILE, printer, commandOverride: Boolean(printCommand) });
});

app.get("/printers", async (_request, response) => {
  const printer = await discoverPrinter();
  response.json({ ok: true, printer });
});

app.post("/print", async (request, response) => {
  try {
    const { image, width, copies = 1 } = request.body ?? {};
    if (width !== 384 || typeof image !== "string" || !image.startsWith("data:image/png;base64,")) {
      return response.status(400).json({ ok: false, error: "Expected a 384-dot PNG data URL." });
    }
    if (copies !== 1) {
      return response.status(400).json({ ok: false, error: "The kiosk only permits one copy per request." });
    }

    await mkdir(jobDirectory, { recursive: true });
    const jobId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const filePath = path.join(jobDirectory, `${jobId}.png`);
    const pngBuffer = Buffer.from(image.split(",")[1], "base64");
    await writeFile(filePath, pngBuffer);
    const commandJob = runPrintCommand(filePath);
    let status;
    let printerName;
    if (commandJob) {
      status = await commandJob;
      printerName = "Configured printer command";
    } else {
      const printer = await discoverPrinter();
      printerName = printer.name;
      if (!printer.ready || printer.mode !== "usb-direct") {
        if (!allowQueueOnly) {
          return response.status(503).json({
            ok: false,
            error: "No supported USB thermal printer is ready. Plug in the POS-58 / JK-5802H and wait a few seconds for Windows to detect it.",
            printer,
          });
        }
        status = "queued-dev";
      } else {
        const rawPath = path.join(jobDirectory, `${jobId}.escpos`);
        await writeFile(rawPath, await pngToEscPos(pngBuffer));
        await writeDirectUsb(rawPath, printer.device);
        status = "printed-usb-direct";
      }
    }

    response.json({ ok: true, jobId, status, printer: printerName });
  } catch (error) {
    console.error("Print failed:", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Print failed." });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Clicked! print agent listening at http://127.0.0.1:${port}`);
  console.log(`Thermal tone profile: ${PRINT_TONE_PROFILE}.`);
  void discoverPrinter().then((printer) => {
    if (printer.ready) console.log(`Auto-detected ${printer.name} (${printer.mode}).`);
    else console.log("Waiting for a POS-58 / JK-5802H USB printer. Hot-plug detection is active.");
  });
});
