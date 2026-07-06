/**
 * Control Route — thin glue between HTTP and NLP
 *
 * No more switch/case routing. The LLM decides what to do via tool calls.
 * This route just:
 *   1. Receives user input
 *   2. Calls processInput() (which runs the LLM tool call loop)
 *   3. Returns the result to the frontend
 */

import { Router, Request, Response } from "express";
import { processInput } from "../nlp";

export const controlRouter = Router();

controlRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { input, userId } = req.body as { input: string; userId: string };

    if (!input || !userId) {
      res.status(400).json({ error: "input and userId are required" });
      return;
    }

    const result = await processInput(input, userId);

    res.json({
      success: true,
      phase: result.phase,
      deviceId: result.deviceId || "",
      message: result.message,
      irCommand: result.irCommand || null,
      setupStep: result.setupStep,
      probeBrand: result.probeBrand,
      probeStep: result.probeStep,
      probeTotal: result.probeTotal,
    });
  } catch (err: any) {
    console.error("[control] error:", err);
    res.status(500).json({ error: err.message });
  }
});
