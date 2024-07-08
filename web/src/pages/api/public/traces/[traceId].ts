import { verifyAuthHeaderAndReturnScope } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { prisma } from "@langfuse/shared/src/db";
import { isPrismaException } from "@/src/utils/exceptions";
import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod";
import { ObservationReturnType } from "@/src/server/api/routers/traces";

const GetTraceSchema = z.object({
  traceId: z.string(),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET") {
    console.error(req.method, req.body, req.query);
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    // CHECK AUTH
    const authCheck = await verifyAuthHeaderAndReturnScope(
      req.headers.authorization,
    );
    if (!authCheck.validKey)
      return res.status(401).json({
        message: authCheck.error,
      });
    // END CHECK AUTH
    console.log("Trying to get trace:", req.body, req.query);

    const { traceId } = GetTraceSchema.parse(req.query);

    // CHECK ACCESS SCOPE
    if (authCheck.scope.accessLevel !== "all") {
      return res.status(401).json({
        message: "Access denied - need to use basic auth with secret key",
      });
    }
    // END CHECK ACCESS SCOPE
    const trace = await prisma.trace.findFirstOrThrow({
      where: {
        id: traceId,
      },
    });
    if (!trace) {
      return res.status(404).json({
        message: "Trace not found within authorized project",
      });
    }
    const observations = await prisma.observationView.findMany({
      select: {
        id: true,
        traceId: true,
        projectId: true,
        type: true,
        startTime: true,
        endTime: true,
        name: true,
        parentObservationId: true,
        level: true,
        statusMessage: true,
        version: true,
        createdAt: true,
        model: true,
        modelParameters: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        unit: true,
        completionStartTime: true,
        timeToFirstToken: true,
        promptId: true,
        modelId: true,
        inputPrice: true,
        outputPrice: true,
        totalPrice: true,
        calculatedInputCost: true,
        calculatedOutputCost: true,
        calculatedTotalCost: true,
        input: true,
        output: true,
        metadata: true,
      },
      where: {
        traceId: {
          equals: traceId,
          not: null,
        },
        projectId: trace.projectId,
      },
    });
    const usage = {
      promptTokens: observations
        .map((o) => o.promptTokens)
        .reduce((a, b) => a + b, 0),
      completionTokens: observations
        .map((o) => o.completionTokens)
        .reduce((a, b) => a + b, 0),
      totalTokens: observations
        .map((o) => o.totalTokens)
        .reduce((a, b) => a + b, 0),
    };
    const manipulatedObservations = observations.map((o) => {
      return {
        ...o,
        latency:
          o.startTime != null && o.endTime != null
            ? (
                ((o.endTime as Date).getTime() -
                  (o.startTime as Date).getTime()) /
                1000
              ).toFixed(2)
            : 0,
      };
    });
    const scores = await prisma.score.findMany({
      where: {
        traceId: traceId,
        projectId: trace.projectId,
      },
    });
    const obsStartTimes = manipulatedObservations
      .map((o) => o.startTime)
      .sort((a, b) => a.getTime() - b.getTime());
    const obsEndTimes = observations
      .map((o) => o.endTime)
      .filter((t) => t)
      .sort((a, b) => (a as Date).getTime() - (b as Date).getTime());
    const latencyMs =
      obsStartTimes.length > 0
        ? obsEndTimes.length > 0
          ? (obsEndTimes[obsEndTimes.length - 1] as Date).getTime() -
            obsStartTimes[0]!.getTime()
          : obsStartTimes.length > 1
            ? obsStartTimes[obsStartTimes.length - 1]!.getTime() -
              obsStartTimes[0]!.getTime()
            : undefined
        : undefined;

    return res.status(200).json({
      ...trace,
      usage,
      scores,
      latency:
        latencyMs !== undefined ? (latencyMs / 1000).toFixed(2) : undefined,
      observations: manipulatedObservations as any as ObservationReturnType[],
    });
  } catch (error: unknown) {
    console.error(error);
    if (isPrismaException(error)) {
      return res.status(500).json({
        error: "Internal Server Error",
      });
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Invalid request data",
        error: error.errors,
      });
    }
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    res.status(500).json({
      message: "Invalid request data",
      error: errorMessage,
    });
  }
}
