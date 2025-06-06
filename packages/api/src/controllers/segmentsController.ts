import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { submitBatchWithTriggers } from "backend-lib/src/apps";
import { SubmitBatchOptions } from "backend-lib/src/apps/batch";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import logger from "backend-lib/src/logger";
import {
  buildSegmentsFile,
  deleteSegment,
  toSegmentResource,
  upsertSegment,
} from "backend-lib/src/segments";
import {
  clearManualSegment,
  getManualSegmentStatus,
  updateManualSegmentUsers,
} from "backend-lib/src/segments/manualSegments";
import { randomUUID } from "crypto";
import csvParser from "csv-parser";
import { and, eq, inArray } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import {
  DataSources,
  SEGMENT_ID_HEADER,
  WORKSPACE_ID_HEADER,
} from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  schemaValidate,
  schemaValidateWithErr,
} from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  BaseUserUploadRow,
  BatchItem,
  ClearManualSegmentRequest,
  CsvUploadValidationError,
  DeleteSegmentRequest,
  EmptyResponse,
  EventType,
  GetManualSegmentStatusRequest,
  GetManualSegmentStatusResponse,
  GetSegmentsRequest,
  GetSegmentsResponse,
  KnownBatchIdentifyData,
  ManualSegmentUploadCsvHeaders,
  SavedSegmentResource,
  SegmentDefinition,
  SegmentNodeType,
  UpdateManualSegmentUsersRequest,
  UpsertSegmentResource,
  UpsertSegmentValidationError,
  UserUploadRowErrors,
} from "isomorphic-lib/src/types";
import { err, ok } from "neverthrow";

import { CsvParseResult } from "../types";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function segmentsController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/",
    {
      schema: {
        description: "Get all segments.",
        tags: ["Segments"],
        querystring: GetSegmentsRequest,
        response: {
          200: GetSegmentsResponse,
        },
      },
    },
    async (request, reply) => {
      const conditions = [
        eq(schema.segment.workspaceId, request.query.workspaceId),
      ];
      if (request.query.ids) {
        conditions.push(inArray(schema.segment.id, request.query.ids));
      }
      if (request.query.resourceType) {
        conditions.push(
          eq(schema.segment.resourceType, request.query.resourceType),
        );
      }
      const segmentModels = await db().query.segment.findMany({
        where: and(...conditions),
      });
      const segments = segmentModels.map((s) => unwrap(toSegmentResource(s)));
      return reply.status(200).send({ segments });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/manual-segment/update",
    {
      schema: {
        description: "Update a manual segment.",
        tags: ["Segments"],
        body: UpdateManualSegmentUsersRequest,
      },
    },
    async (request, reply) => {
      await updateManualSegmentUsers(request.body);
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/manual-segment/clear",
    {
      schema: {
        description: "Clear a manual segment.",
        tags: ["Segments"],
        body: ClearManualSegmentRequest,
      },
    },
    async (request, reply) => {
      await clearManualSegment(request.body);
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/manual-segment/status",
    {
      schema: {
        description: "Get the status of a manual segment.",
        tags: ["Segments"],
        querystring: GetManualSegmentStatusRequest,
        response: {
          200: GetManualSegmentStatusResponse,
        },
      },
    },
    async (request, reply) => {
      const status = await getManualSegmentStatus(request.query);
      if (!status) {
        return reply.status(404).send();
      }
      return reply.status(200).send(status);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/",
    {
      schema: {
        description: "Create or update a user segment.",
        tags: ["Segments"],
        body: UpsertSegmentResource,
        response: {
          200: SavedSegmentResource,
          400: UpsertSegmentValidationError,
        },
      },
    },
    async (request, reply) => {
      const result = await upsertSegment(request.body);
      if (result.isErr()) {
        return reply.status(400).send(result.error);
      }
      return reply.status(200).send(result.value);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/",
    {
      schema: {
        description: "Delete a segment.",
        tags: ["Segments"],
        body: DeleteSegmentRequest,
        response: {
          204: EmptyResponse,
          404: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await deleteSegment(request.body);
      if (!result) {
        return reply.status(404).send();
      }
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/v2",
    {
      schema: {
        description: "Delete a segment.",
        tags: ["Segments"],
        querystring: DeleteSegmentRequest,
        response: {
          204: EmptyResponse,
          404: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await deleteSegment(request.query);
      if (!result) {
        return reply.status(404).send();
      }
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/download",
    {
      schema: {
        description: "Download a csv containing segment assignments.",
        tags: ["Segments"],
        querystring: Type.Object({
          workspaceId: Type.String(),
        }),
        200: {
          type: "string",
          format: "binary",
        },
      },
    },

    async (request, reply) => {
      const { fileName, fileContent } = await buildSegmentsFile({
        workspaceId: request.query.workspaceId,
      });
      return reply
        .header("Content-Disposition", `attachment; filename=${fileName}`)
        .type("text/csv")
        .send(fileContent);
    },
  );
  // await fastify.register(fastifyMultipart);

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/upload-csv",
    {
      schema: {
        // TODO upload files to S3 and use a presigned URL
        tags: ["Segments"],
        description:
          "Upload a CSV file to add or remove users from a manual segment.",
        headers: ManualSegmentUploadCsvHeaders,
      },
    },
    async (request, reply) => {
      const file = (await request.file())?.file;
      if (!file) {
        return reply.status(400).send({
          message: "missing file",
        });
      }
      const csvStream = file;
      const workspaceId = request.headers[WORKSPACE_ID_HEADER];
      const segmentId = request.headers[SEGMENT_ID_HEADER];

      // Parse the CSV stream into a JavaScript object with an array of rows
      const csvPromise = new Promise<CsvParseResult>((resolve) => {
        const parsingErrors: UserUploadRowErrors[] = [];
        const uploadedRows: BaseUserUploadRow[] = [];

        let i = 0;
        csvStream
          .pipe(csvParser())
          .on("headers", (headers: string[]) => {
            if (!headers.includes("id")) {
              resolve(err('csv must have "id" header'));
              csvStream.destroy(); // This will stop the parsing process
            }
          })
          .on("data", (row: unknown) => {
            if (row instanceof Object && Object.keys(row).length === 0) {
              return;
            }
            const parsed = schemaValidate(row, BaseUserUploadRow);
            const rowNumber = i;
            i += 1;

            if (parsed.isErr()) {
              const errors = {
                row: rowNumber,
                error: 'row must have a non-empty "id" field',
              };
              parsingErrors.push(errors);
              return;
            }

            const { value } = parsed;
            if (value.id.length === 0) {
              const errors = {
                row: rowNumber,
                error: 'row must have a non-empty "id" field',
              };
              parsingErrors.push(errors);
              return;
            }

            uploadedRows.push(parsed.value);
          })
          .on("end", () => {
            logger().debug(
              `Parsed ${uploadedRows.length} rows for workspace: ${workspaceId}`,
            );
            if (parsingErrors.length) {
              resolve(err(parsingErrors));
            } else {
              resolve(ok(uploadedRows));
            }
          })
          .on("error", (error) => {
            resolve(err(error));
          });
      });
      const [rows, segment] = await Promise.all([
        csvPromise,
        db().query.segment.findFirst({
          where: eq(schema.segment.id, segmentId),
        }),
      ]);
      const definitionResult = schemaValidateWithErr(
        segment?.definition,
        SegmentDefinition,
      );
      if (definitionResult.isErr()) {
        logger().error(
          {
            segmentId,
            definition: segment?.definition,
          },
          "segment definition is invalid",
        );
        return reply.status(500);
      }
      const definition = definitionResult.value;
      if (definition.entryNode.type !== SegmentNodeType.Manual) {
        return reply.status(400).send({
          message: "segment must have a manual entry node",
        });
      }

      if (rows.isErr()) {
        if (rows.error instanceof Error) {
          const errorResponse: CsvUploadValidationError = {
            message: `misformatted file: ${rows.error.message}`,
          };
          return reply.status(400).send(errorResponse);
        }

        if (rows.error instanceof Array) {
          const errorResponse: CsvUploadValidationError = {
            message: "csv rows contained errors",
            rowErrors: rows.error,
          };
          return reply.status(400).send(errorResponse);
        }

        const errorResponse: CsvUploadValidationError = {
          message: rows.error,
        };
        return reply.status(400).send(errorResponse);
      }

      const currentTime = new Date();
      const timestamp = currentTime.toISOString();
      const userIds = rows.value.map((row) => row.id);

      const batch: BatchItem[] = rows.value.flatMap((row) => {
        const { id, ...rest } = row;
        if (Object.keys(rest).length === 0) {
          return [];
        }
        const event: KnownBatchIdentifyData = {
          type: EventType.Identify,
          userId: id,
          timestamp,
          traits: rest,
          messageId: randomUUID(),
        };
        return event;
      });

      if (batch.length > 0) {
        const data: SubmitBatchOptions = {
          workspaceId,
          data: {
            context: {
              source: DataSources.ManualSegment,
            },
            batch,
          },
        };
        await submitBatchWithTriggers(data);
      }
      await updateManualSegmentUsers({
        workspaceId,
        segmentId,
        userIds,
        sync: true,
      });

      const response = await reply.status(200).send();
      return response;
    },
  );
}
