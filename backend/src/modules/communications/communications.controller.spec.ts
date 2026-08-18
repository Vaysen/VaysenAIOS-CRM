import { ForbiddenException } from "@nestjs/common";
import { RouterResponseController } from "@nestjs/core/router/router-response-controller";
import { CommunicationsController } from "./communications.controller";
import { CommunicationsService } from "./communications.service";

describe("CommunicationsController SSE active-tenant boundary", () => {
  const activeUser = {
    id: "user-1",
    email: "operator@example.invalid",
    activeCompanyId: "company-active",
    activeCompany: { id: "company-active", role: "sales_user" },
    companies: [{ id: "company-foreign" }, { id: "company-active" }],
  };

  function createHarness(
    membership: any = {
      id: "membership-1",
      role: { name: "sales_user" },
    },
  ) {
    const prisma: any = {
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue(membership),
      },
    };
    const communications = new CommunicationsService(
      prisma,
      {} as any,
      {} as any,
    );
    const handlers = new Map<string, (payload: any) => void>();
    const cleanups = new Map<string, jest.Mock>();
    const eventBus: any = {
      on: jest.fn((event: string, handler: (payload: any) => void) => {
        handlers.set(event, handler);
        const cleanup = jest.fn();
        cleanups.set(event, cleanup);
        return cleanup;
      }),
    };
    const controller = new CommunicationsController(
      communications,
      eventBus,
      {} as any,
    );
    return { controller, prisma, eventBus, handlers, cleanups };
  }

  async function flushAuthorizationPipeline() {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns an Observable synchronously that satisfies the Nest SSE runtime assertion", () => {
    const { controller } = createHarness();

    const stream = controller.sseEvents(activeUser);

    expect(stream).not.toBeInstanceOf(Promise);
    expect(() => {
      (RouterResponseController.prototype as any).assertObservable(stream);
    }).not.toThrow();
  });

  it("subscribes only after DB authorization and emits only the active tenant", async () => {
    const { controller, prisma, eventBus, handlers, cleanups } =
      createHarness();
    const received: any[] = [];
    const logSpy = jest.spyOn((controller as any).logger, "log");
    const debugSpy = jest.spyOn((controller as any).logger, "debug");

    const subscription = controller.sseEvents(activeUser).subscribe({
      next: (event) => received.push(event),
    });
    await flushAuthorizationPipeline();

    expect(prisma.userCompanyRelation.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        companyId: "company-active",
        isActive: true,
        user: { is: { isActive: true, deletedAt: null } },
        company: { is: { isActive: true } },
      },
      include: { role: { select: { name: true } } },
    });
    expect(eventBus.on).toHaveBeenCalledTimes(3);

    handlers.get("whatsapp.message")?.({
      companyId: "company-foreign",
      marker: "foreign-whatsapp",
    });
    handlers.get("conversation.update")?.({
      companyId: "company-foreign",
      marker: "foreign-conversation",
    });
    handlers.get("whatsapp.message")?.({
      companyId: "company-active",
      conversationId: "conversation-active",
      messageId: "message-active",
      direction: "inbound",
      contentType: "text",
      timestamp: "2026-08-03T00:00:00.000Z",
    });
    handlers.get("conversation.update")?.({
      companyId: "company-active",
      conversationId: "conversation-active",
      direction: "outbound",
      contentType: "html",
      timestamp: "2026-08-03T00:01:00.000Z",
    });

    expect(received.filter((event) => event.type === "whatsapp.message")).toEqual([
      {
        type: "whatsapp.message",
        data: {
          conversationId: "conversation-active",
          messageId: "message-active",
          emailId: null,
          direction: "inbound",
          contentType: "text",
          updatedAt: null,
          timestamp: "2026-08-03T00:00:00.000Z",
        },
      },
    ]);
    expect(received.filter((event) => event.type === "conversation.update")).toEqual([
      {
        type: "conversation.update",
        data: {
          conversationId: "conversation-active",
          messageId: null,
          emailId: null,
          direction: "outbound",
          contentType: "html",
          updatedAt: null,
          timestamp: "2026-08-03T00:01:00.000Z",
        },
      },
    ]);

    handlers.get("email.received")?.({
      companyId: "company-active",
      conversationId: "conversation-email",
      emailId: "email-active",
      direction: "inbound",
      contentType: "html",
      timestamp: "2026-08-03T00:02:00.000Z",
    });
    expect(received.filter((event) => event.type === "email.received")).toEqual([
      {
        type: "email.received",
        data: {
          conversationId: "conversation-email",
          messageId: null,
          emailId: "email-active",
          direction: "inbound",
          contentType: "html",
          updatedAt: null,
          timestamp: "2026-08-03T00:02:00.000Z",
        },
      },
    ]);

    const sensitivePayload = {
      companyId: "company-active",
      conversationId: "conversation-safe",
      messageId: "message-safe",
      emailId: "email-safe",
      leadName: "SENTINEL_COMPANY_NAME",
      fromPhone: "+8613800138000",
      receiverPhone: "+14155550123",
      jid: "15551234567@s.whatsapp.net",
      sessionId: "session-secret",
      providerId: "provider-secret",
      body: "SENTINEL_MESSAGE_BODY ".repeat(30),
      subject: "SENTINEL_SUBJECT",
      messagePreview: "SENTINEL_MESSAGE_PREVIEW ".repeat(30),
      subjectPreview: "SENTINEL_SUBJECT_PREVIEW",
      extra: "SENTINEL_EXTRA",
      direction: "inbound",
      contentType: "text",
      timestamp: "2026-08-03T00:03:00.000Z",
    };
    handlers.get("whatsapp.message")?.(sensitivePayload);
    handlers.get("email.received")?.({
      ...sensitivePayload,
      emailId: "email-safe-2",
      contentType: "html",
    });

    const sensitiveEvents = received.filter((event) => (
      event.type === "whatsapp.message" || event.type === "email.received"
    ));
    for (const event of sensitiveEvents.slice(-2)) {
      expect(Object.keys(event.data).sort()).toEqual([
        "contentType",
        "conversationId",
        "direction",
        "emailId",
        "messageId",
        "timestamp",
        "updatedAt",
      ]);
      const serialized = JSON.stringify(event);
      for (const sentinel of [
        "SENTINEL_COMPANY_NAME",
        "+8613800138000",
        "+14155550123",
        "15551234567@s.whatsapp.net",
        "session-secret",
        "provider-secret",
        "SENTINEL_MESSAGE_BODY",
        "SENTINEL_SUBJECT",
        "SENTINEL_MESSAGE_PREVIEW",
        "SENTINEL_SUBJECT_PREVIEW",
        "SENTINEL_EXTRA",
      ]) {
        expect(serialized).not.toContain(sentinel);
      }
      expect(event.data).not.toHaveProperty("messagePreview");
      expect(event.data).not.toHaveProperty("subjectPreview");
    }

    subscription.unsubscribe();
    expect(cleanups.get("whatsapp.message")).toHaveBeenCalledTimes(1);
    expect(cleanups.get("email.received")).toHaveBeenCalledTimes(1);
    expect(cleanups.get("conversation.update")).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    const serializedLogs = [
      ...logSpy.mock.calls,
      ...debugSpy.mock.calls,
    ].flat().map(String).join("\n");
    expect(serializedLogs).toContain('"matched":true');
    expect(serializedLogs).toContain('"matched":false');
    for (const sentinel of [
      activeUser.email,
      "company-active",
      "SENTINEL_COMPANY_NAME",
      "+8613800138000",
      "15551234567@s.whatsapp.net",
      "SENTINEL_MESSAGE_BODY",
      "SENTINEL_SUBJECT",
      "SENTINEL_EXTRA",
    ]) {
      expect(serializedLogs).not.toContain(sentinel);
    }
  });

  it.each([
    [
      "missing activeCompanyId despite another JWT membership",
      {
        id: "user-1",
        email: "operator@example.invalid",
        companies: [{ id: "company-foreign" }],
      },
      { membership: undefined, expectDatabaseLookup: false },
    ],
    [
      "stale or inactive database relation",
      activeUser,
      { membership: null, expectDatabaseLookup: true },
    ],
    [
      "foreign active tenant without an exact relation",
      {
        ...activeUser,
        activeCompanyId: "company-foreign",
        activeCompany: { id: "company-foreign", role: "company_admin" },
      },
      { membership: null, expectDatabaseLookup: true },
    ],
  ])("fails closed on subscription for %s", async (_label, user, options) => {
    const { controller, prisma, eventBus } = createHarness(options.membership);
    const errors: unknown[] = [];

    const stream = controller.sseEvents(user);
    expect(() => {
      (RouterResponseController.prototype as any).assertObservable(stream);
    }).not.toThrow();
    const subscription = stream.subscribe({
      error: (error) => errors.push(error),
    });
    await flushAuthorizationPipeline();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ForbiddenException);
    expect(eventBus.on).not.toHaveBeenCalled();
    if (options.expectDatabaseLookup) {
      expect(prisma.userCompanyRelation.findFirst).toHaveBeenCalledTimes(1);
    } else {
      expect(prisma.userCompanyRelation.findFirst).not.toHaveBeenCalled();
    }
    subscription.unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not attach listeners if the client disconnects before authorization resolves", async () => {
    let resolveMembership!: (value: any) => void;
    const membershipPromise = new Promise((resolve) => {
      resolveMembership = resolve;
    });
    const { controller, prisma, eventBus } = createHarness();
    prisma.userCompanyRelation.findFirst.mockReturnValue(membershipPromise);

    const subscription = controller.sseEvents(activeUser).subscribe();
    subscription.unsubscribe();
    resolveMembership({
      id: "membership-late",
      role: { name: "sales_user" },
    });
    await flushAuthorizationPipeline();

    expect(eventBus.on).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
