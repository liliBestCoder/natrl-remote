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
  const startTime = Date.now();
  try {
    const { input, userId } = req.body as { input: string; userId: string };

    if (!input || !userId) {
      res.status(400).json({ error: "input and userId are required" });
      return;
    }

    console.log(`\n[api] ═══════════ 收到请求 ═══════════`);
    console.log(`[api] ← 用户: ${input}`);

    const result = await processInput(input, userId);

    const elapsed = Date.now() - startTime;
    const tc = result.toolCall;
    console.log(`[api] → 回复: ${result.message}`);
    if (tc) {
      console.log(`[api] → toolCall: ${JSON.stringify(tc)}`);
    }
    console.log(`[api] → ${elapsed}ms | phase=${result.phase}`);
    console.log(`[api] ═══════════════════════════════\n`);

    res.json({
      success: true,
      phase: result.phase,
      deviceId: result.deviceId || "",
      message: result.message,
      toolCall: result.toolCall || null,
      setupStep: result.setupStep,
      probeBrand: result.probeBrand,
      probeStep: result.probeStep,
      probeTotal: result.probeTotal,
    });
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[api] ✗ 错误 | ${elapsed}ms | ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
