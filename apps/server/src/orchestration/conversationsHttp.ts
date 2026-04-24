import { Data, Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  OrchestrationConversationApprovalResponseInput,
  OrchestrationConversationCommandResult,
  OrchestrationConversationCreateInput,
  OrchestrationConversationInterruptInput,
  OrchestrationConversationListResult,
  OrchestrationConversationSendMessageInput,
  OrchestrationConversationSendMessageResult,
  OrchestrationConversationStatusResult,
  OrchestrationConversationUserInputResponseInput,
  ThreadId,
} from "@t3tools/contracts";

import { respondToAuthError } from "../auth/http.ts";
import { type AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { dispatchClientOrchestrationCommand } from "./dispatchClientCommand.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const CONVERSATIONS_ROUTE_PREFIX = "/api/v1/conversations";

class ConversationApiError extends Data.TaggedError("ConversationApiError")<{
  readonly message: string;
  readonly status: 400 | 404 | 500;
  readonly cause?: unknown;
}> {}

const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

const makeApiCommandId = (action: string) =>
  CommandId.make(`api:conversations:${action}:${crypto.randomUUID()}`);

const respondToConversationApiError = (error: ConversationApiError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("conversation api route failed", {
        message: error.message,
        cause: error.cause,
      });
    }

    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status });
  });

const authenticateConversationApiSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  return yield* serverAuth.authenticateHttpRequest(request);
});

const getRequestUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return yield* new ConversationApiError({
      message: "Invalid request URL.",
      status: 400,
    });
  }
  return url.value;
});

const decodeConversationThreadId = (rawThreadId: string) =>
  decodeThreadId(rawThreadId).pipe(
    Effect.mapError(
      (cause) =>
        new ConversationApiError({
          message: "Invalid conversation id.",
          status: 400,
          cause,
        }),
    ),
  );

const getConversationThreadIdFromRoute = (suffix = "") =>
  Effect.gen(function* () {
    const url = yield* getRequestUrl;
    const prefix = `${CONVERSATIONS_ROUTE_PREFIX}/`;
    if (!url.pathname.startsWith(prefix)) {
      return yield* new ConversationApiError({
        message: "Conversation was not found.",
        status: 404,
      });
    }

    if (suffix.length > 0 && !url.pathname.endsWith(suffix)) {
      return yield* new ConversationApiError({
        message: "Conversation action was not found.",
        status: 404,
      });
    }

    const endIndex = suffix.length > 0 ? url.pathname.length - suffix.length : url.pathname.length;
    const rawThreadId = decodeURIComponent(url.pathname.slice(prefix.length, endIndex));
    if (rawThreadId.length === 0 || rawThreadId.includes("/")) {
      return yield* new ConversationApiError({
        message: "Conversation was not found.",
        status: 404,
      });
    }

    return yield* decodeConversationThreadId(rawThreadId);
  });

const getConversationShellById = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ConversationApiError({
            message: "Failed to load conversation status.",
            status: 500,
            cause,
          }),
      ),
    );

    if (Option.isNone(thread)) {
      return yield* new ConversationApiError({
        message: `Conversation ${threadId} was not found.`,
        status: 404,
      });
    }

    return thread.value;
  });

const dispatchConversationCommand = (command: ClientOrchestrationCommand) =>
  dispatchClientOrchestrationCommand(command).pipe(
    Effect.mapError(
      (error) =>
        new ConversationApiError({
          message: error.message,
          status: 400,
          cause: error.cause,
        }),
    ),
  );

const conversationRouteCauseHandlers = <A, R>(
  effect: Effect.Effect<A, AuthError | ConversationApiError, R>,
) =>
  effect.pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("ConversationApiError", respondToConversationApiError),
  );

export const conversationsListRouteLayer = HttpRouter.add(
  "GET",
  CONVERSATIONS_ROUTE_PREFIX,
  conversationRouteCauseHandlers(
    Effect.gen(function* () {
      yield* authenticateConversationApiSession;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(
          (cause) =>
            new ConversationApiError({
              message: "Failed to load conversations.",
              status: 500,
              cause,
            }),
        ),
      );

      return HttpServerResponse.jsonUnsafe(
        {
          snapshotSequence: snapshot.snapshotSequence,
          conversations: snapshot.threads,
          updatedAt: snapshot.updatedAt,
        } satisfies OrchestrationConversationListResult,
        { status: 200 },
      );
    }),
  ),
);

export const conversationsStatusRouteLayer = HttpRouter.add(
  "GET",
  `${CONVERSATIONS_ROUTE_PREFIX}/:threadId`,
  conversationRouteCauseHandlers(
    Effect.gen(function* () {
      yield* authenticateConversationApiSession;
      const threadId = yield* getConversationThreadIdFromRoute();
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(
          (cause) =>
            new ConversationApiError({
              message: "Failed to load conversation status.",
              status: 500,
              cause,
            }),
        ),
      );

      const conversation = snapshot.threads.find((thread) => thread.id === threadId) ?? null;
      if (!conversation) {
        return yield* new ConversationApiError({
          message: `Conversation ${threadId} was not found.`,
          status: 404,
        });
      }

      return HttpServerResponse.jsonUnsafe(
        {
          snapshotSequence: snapshot.snapshotSequence,
          conversation,
        } satisfies OrchestrationConversationStatusResult,
        { status: 200 },
      );
    }),
  ),
);

export const conversationsCreateRouteLayer = HttpRouter.add(
  "POST",
  CONVERSATIONS_ROUTE_PREFIX,
  conversationRouteCauseHandlers(
    Effect.gen(function* () {
      yield* authenticateConversationApiSession;
      const payload = yield* HttpServerRequest.schemaBodyJson(
        OrchestrationConversationCreateInput,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ConversationApiError({
              message: "Invalid conversation create payload.",
              status: 400,
              cause,
            }),
        ),
      );

      const createdAt = new Date().toISOString();
      const threadId = ThreadId.make(crypto.randomUUID());
      const commandId = makeApiCommandId("create");
      const result = yield* dispatchConversationCommand({
        type: "thread.create",
        commandId,
        threadId,
        projectId: payload.projectId,
        title: payload.title,
        modelSelection: payload.modelSelection,
        runtimeMode: payload.runtimeMode,
        interactionMode: payload.interactionMode,
        branch: payload.branch,
        worktreePath: payload.worktreePath,
        createdAt,
      });

      return HttpServerResponse.jsonUnsafe(
        {
          sequence: result.sequence,
          threadId,
          commandId,
          createdAt,
        } satisfies OrchestrationConversationCommandResult,
        { status: 201 },
      );
    }),
  ),
);

export const conversationsMessageRouteLayer = HttpRouter.add(
  "POST",
  `${CONVERSATIONS_ROUTE_PREFIX}/:threadId/messages`,
  conversationRouteCauseHandlers(
    Effect.gen(function* () {
      yield* authenticateConversationApiSession;
      const threadId = yield* getConversationThreadIdFromRoute("/messages");
      const conversation = yield* getConversationShellById(threadId);
      const payload = yield* HttpServerRequest.schemaBodyJson(
        OrchestrationConversationSendMessageInput,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ConversationApiError({
              message: "Invalid conversation message payload.",
              status: 400,
              cause,
            }),
        ),
      );

      const createdAt = new Date().toISOString();
      const commandId = makeApiCommandId("message");
      const messageId = MessageId.make(crypto.randomUUID());
      const result = yield* dispatchConversationCommand({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: payload.text,
          attachments: payload.attachments,
        },
        ...(payload.modelSelection ? { modelSelection: payload.modelSelection } : {}),
        ...(payload.titleSeed ? { titleSeed: payload.titleSeed } : {}),
        runtimeMode: conversation.runtimeMode,
        interactionMode: conversation.interactionMode,
        createdAt,
      });

      return HttpServerResponse.jsonUnsafe(
        {
          sequence: result.sequence,
          threadId,
          messageId,
          commandId,
          createdAt,
        } satisfies OrchestrationConversationSendMessageResult,
        { status: 200 },
      );
    }),
  ),
);

export const conversationsInterruptRouteLayer = HttpRouter.add(
  "POST",
  `${CONVERSATIONS_ROUTE_PREFIX}/:threadId/interrupt`,
  conversationRouteCauseHandlers(
    Effect.gen(function* () {
      yield* authenticateConversationApiSession;
      const threadId = yield* getConversationThreadIdFromRoute("/interrupt");
      yield* getConversationShellById(threadId);
      const payload = yield* HttpServerRequest.schemaBodyJson(
        OrchestrationConversationInterruptInput,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ConversationApiError({
              message: "Invalid conversation interrupt payload.",
              status: 400,
              cause,
            }),
        ),
      );

      const createdAt = new Date().toISOString();
      const commandId = makeApiCommandId("interrupt");
      const result = yield* dispatchConversationCommand({
        type: "thread.turn.interrupt",
        commandId,
        threadId,
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        createdAt,
      });

      return HttpServerResponse.jsonUnsafe(
        {
          sequence: result.sequence,
          threadId,
          commandId,
          createdAt,
        } satisfies OrchestrationConversationCommandResult,
        { status: 200 },
      );
    }),
  ),
);

export const conversationsApprovalRouteLayer = HttpRouter.add(
  "POST",
  `${CONVERSATIONS_ROUTE_PREFIX}/:threadId/approval`,
  conversationRouteCauseHandlers(
    Effect.gen(function* () {
      yield* authenticateConversationApiSession;
      const threadId = yield* getConversationThreadIdFromRoute("/approval");
      yield* getConversationShellById(threadId);
      const payload = yield* HttpServerRequest.schemaBodyJson(
        OrchestrationConversationApprovalResponseInput,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ConversationApiError({
              message: "Invalid conversation approval payload.",
              status: 400,
              cause,
            }),
        ),
      );

      const createdAt = new Date().toISOString();
      const commandId = makeApiCommandId("approval");
      const result = yield* dispatchConversationCommand({
        type: "thread.approval.respond",
        commandId,
        threadId,
        requestId: payload.requestId,
        decision: payload.decision,
        createdAt,
      });

      return HttpServerResponse.jsonUnsafe(
        {
          sequence: result.sequence,
          threadId,
          commandId,
          createdAt,
        } satisfies OrchestrationConversationCommandResult,
        { status: 200 },
      );
    }),
  ),
);

export const conversationsUserInputRouteLayer = HttpRouter.add(
  "POST",
  `${CONVERSATIONS_ROUTE_PREFIX}/:threadId/user-input`,
  conversationRouteCauseHandlers(
    Effect.gen(function* () {
      yield* authenticateConversationApiSession;
      const threadId = yield* getConversationThreadIdFromRoute("/user-input");
      yield* getConversationShellById(threadId);
      const payload = yield* HttpServerRequest.schemaBodyJson(
        OrchestrationConversationUserInputResponseInput,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ConversationApiError({
              message: "Invalid conversation user input payload.",
              status: 400,
              cause,
            }),
        ),
      );

      const createdAt = new Date().toISOString();
      const commandId = makeApiCommandId("user-input");
      const result = yield* dispatchConversationCommand({
        type: "thread.user-input.respond",
        commandId,
        threadId,
        requestId: payload.requestId,
        answers: payload.answers,
        createdAt,
      });

      return HttpServerResponse.jsonUnsafe(
        {
          sequence: result.sequence,
          threadId,
          commandId,
          createdAt,
        } satisfies OrchestrationConversationCommandResult,
        { status: 200 },
      );
    }),
  ),
);
