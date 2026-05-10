/**
 * Sky's Memory Module
 *
 * Long-term persistent memory using Prisma + MySQL.
 * Nothing is lost. Everything compounds.
 */

import prisma from './prisma-client.js';
import embeddings from './embeddings.js';

export class Memory {
  // ============================================================
  // CONVERSATIONS — Sky remembers every interaction
  // ============================================================

  /**
   * Store a conversation message.
   * Automatically links to the active session and updates session stats.
   */
  async saveMessage({ source, role, content, metadata = null, agentId = null, companyId = null }) {
    // Get or create active session for this source
    const session = await this.getOrCreateSession(source);

    const conversation = await prisma.conversation.create({
      data: { source, role, content, metadata, agentId, companyId, sessionId: session.id },
    });

    // Update session stats (fire and forget — don't block)
    prisma.session.update({
      where: { id: session.id },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: new Date(),
      },
    }).catch(e => console.warn(`[Memory] Failed to update session stats: ${e.message}`));

    // Embed for semantic search (fire and forget — don't slow down responses)
    embeddings.embedAndStore('conversation', conversation.id, content)
      .catch(e => console.warn(`[Memory] Failed to embed conversation: ${e.message}`));

    return conversation;
  }

  /**
   * Get recent conversations (for context in new prompts).
   */
  async getRecentConversations({ limit = 50, source = null, companyId = null } = {}) {
    const where = {};
    if (source) where.source = source;
    if (companyId) where.companyId = companyId;

    return prisma.conversation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Search conversations by content.
   */
  async searchConversations(query, limit = 20) {
    return prisma.conversation.findMany({
      where: {
        content: { contains: query },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ============================================================
  // SESSIONS — Conversation session tracking
  // ============================================================

  /**
   * Get or create an active session for this source.
   * If the last message was more than 30 minutes ago, close the old session and start a new one.
   */
  async getOrCreateSession(source) {
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    const existing = await prisma.session.findFirst({
      where: { source, active: true },
      orderBy: { lastMessageAt: 'desc' },
    });

    if (existing) {
      const elapsed = Date.now() - new Date(existing.lastMessageAt).getTime();
      if (elapsed < SESSION_TIMEOUT_MS) {
        return existing;
      }
      // Timed out — close the old session
      await this.closeSession(existing.id);
      console.log(`[Sky] Session timed out after ${Math.round(elapsed / 60000)}m of inactivity`);
    }

    // Create a new session
    const session = await prisma.session.create({
      data: { source },
    });
    console.log(`[Sky] New session started (${source}): ${session.id}`);
    return session;
  }

  /**
   * Update the session topic (auto-detected from conversation).
   */
  async updateSessionTopic(sessionId, topic) {
    console.log(`[Sky] Session topic detected: "${topic}"`);
    return prisma.session.update({
      where: { id: sessionId },
      data: { topic },
    });
  }

  /**
   * Update the running summary of a session.
   */
  async updateSessionSummary(sessionId, summary) {
    return prisma.session.update({
      where: { id: sessionId },
      data: { summary },
    });
  }

  /**
   * Close a session (mark as inactive).
   */
  async closeSession(sessionId) {
    return prisma.session.update({
      where: { id: sessionId },
      data: { active: false },
    });
  }

  /**
   * Get all messages for a specific session.
   */
  async getSessionMessages(sessionId, limit = 50) {
    return prisma.conversation.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Get recent sessions with their topics/summaries (for context about past conversations).
   */
  async getRecentSessions(source, limit = 5) {
    return prisma.session.findMany({
      where: { source, active: false },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      select: {
        id: true,
        topic: true,
        summary: true,
        messageCount: true,
        createdAt: true,
        lastMessageAt: true,
      },
    });
  }

  /**
   * Get the currently active session for a source (without creating one).
   */
  async getActiveSession(source) {
    return prisma.session.findFirst({
      where: { source, active: true },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  /**
   * Get recent decisions (not just pending review — all recent ones).
   */
  async getRecentDecisions(limit = 10) {
    return prisma.decision.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get active action items (decisions with reviewDate in the next 7 days).
   */
  async getActiveActionItems() {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return prisma.decision.findMany({
      where: {
        status: { in: ['made', 'tracking'] },
        reviewDate: { gte: now, lte: sevenDaysFromNow },
      },
      orderBy: { reviewDate: 'asc' },
    });
  }

  // ============================================================
  // DECISIONS — Track what was decided and what happened
  // ============================================================

  async logDecision({ title, description, context = null, companyId = null, reviewDate = null }) {
    const decision = await prisma.decision.create({
      data: { title, description, context, companyId, reviewDate },
    });

    // Embed for semantic search (fire and forget)
    embeddings.embedAndStore('decision', decision.id, `${title} ${description}`)
      .catch(e => console.warn(`[Memory] Failed to embed decision: ${e.message}`));

    return decision;
  }

  async updateDecisionOutcome(id, outcome, status = 'validated') {
    return prisma.decision.update({
      where: { id },
      data: { outcome, status, updatedAt: new Date() },
    });
  }

  async getDecisionsDueForReview() {
    return prisma.decision.findMany({
      where: {
        status: { in: ['made', 'tracking'] },
        reviewDate: { lte: new Date() },
      },
      orderBy: { reviewDate: 'asc' },
    });
  }

  async getDecisionsByCompany(companyId) {
    return prisma.decision.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ============================================================
  // KNOWLEDGE GRAPH — The compounding intelligence
  // ============================================================

  async addKnowledge({ title, content, category, tags = [], companyId = null, sourceType = 'conversation' }) {
    const knowledge = await prisma.knowledge.create({
      data: { title, content, category, tags, companyId, sourceType },
    });

    // Embed for semantic search (fire and forget)
    embeddings.embedAndStore('knowledge', knowledge.id, `${title} ${content}`)
      .catch(e => console.warn(`[Memory] Failed to embed knowledge: ${e.message}`));

    return knowledge;
  }

  /**
   * Search knowledge by tags or content.
   */
  async searchKnowledge({ query = null, category = null, companyId = null, limit = 20 } = {}) {
    const where = {};
    if (category) where.category = category;
    if (companyId) where.companyId = companyId;
    if (query) where.content = { contains: query };

    return prisma.knowledge.findMany({
      where,
      orderBy: { confidence: 'desc' },
      take: limit,
    });
  }

  /**
   * Boost knowledge confidence (validated across companies).
   */
  async boostKnowledge(id) {
    const k = await prisma.knowledge.findUnique({ where: { id } });
    if (!k) return null;
    return prisma.knowledge.update({
      where: { id },
      data: {
        confidence: Math.min(k.confidence + 0.1, 1.0),
        validated: true,
      },
    });
  }

  /**
   * Decay old unvalidated knowledge.
   * Run periodically (weekly).
   */
  async decayKnowledge(daysOld = 90) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    return prisma.knowledge.updateMany({
      where: {
        validated: false,
        updatedAt: { lt: cutoff },
        confidence: { gt: 0.1 },
      },
      data: {
        confidence: { decrement: 0.05 },
      },
    });
  }

  // ============================================================
  // USER PROFILE — Sky learns your preferences over time
  // ============================================================

  async setPreference(key, value, category = 'preference', source = 'inferred') {
    return prisma.userProfile.upsert({
      where: { key },
      create: { key, value, category, source },
      update: { value, category, source, updatedAt: new Date() },
    });
  }

  async getPreference(key) {
    const pref = await prisma.userProfile.findUnique({ where: { key } });
    return pref?.value || null;
  }

  async getAllPreferences(category = null) {
    const where = category ? { category } : {};
    return prisma.userProfile.findMany({ where });
  }

  // ============================================================
  // TASKS — What work has been done
  // ============================================================

  async logTask({ prompt, agentId = null, repoId = null, companyId = null, model = null }) {
    return prisma.taskLog.create({
      data: { prompt, agentId, repoId, companyId, model, status: 'running' },
    });
  }

  async completeTask(id, { result = null, duration = null, cost = null, tokens = null } = {}) {
    return prisma.taskLog.update({
      where: { id },
      data: { result, duration, cost, tokens, status: 'completed', completedAt: new Date() },
    });
  }

  async failTask(id, error) {
    return prisma.taskLog.update({
      where: { id },
      data: { result: error, status: 'failed', completedAt: new Date() },
    });
  }

  async getTaskStats(companyId = null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const where = { createdAt: { gte: since } };
    if (companyId) where.companyId = companyId;

    const tasks = await prisma.taskLog.findMany({ where });

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const totalCost = tasks.reduce((sum, t) => sum + (t.cost || 0), 0);
    const totalTokens = tasks.reduce((sum, t) => sum + (t.tokens || 0), 0);

    return { total, completed, failed, totalCost, totalTokens, successRate: total > 0 ? completed / total : 0 };
  }

  // ============================================================
  // AGENTS — Status and orchestration
  // ============================================================

  /**
   * Find the orchestrator agent for a company.
   */
  async getOrchestratorForCompany(companyId) {
    return prisma.agent.findFirst({
      where: { companyId, isOrchestrator: true },
      include: { company: true, repo: true },
    });
  }

  /**
   * Get an agent's current status — what they're working on, recent history, knowledge.
   * This is what the 3D office NPCs surface when you walk up to them.
   */
  async getAgentStatus(agentId) {
    const [agent, recentTasks, activeTasks, recentDecisions, knowledge] = await Promise.all([
      prisma.agent.findUnique({
        where: { id: agentId },
        include: { company: true, repo: true },
      }),
      prisma.taskLog.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.taskLog.findMany({
        where: { agentId, status: 'running' },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.decision.findMany({
        where: { companyId: (await prisma.agent.findUnique({ where: { id: agentId } }))?.companyId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.knowledge.findMany({
        where: { companyId: (await prisma.agent.findUnique({ where: { id: agentId } }))?.companyId },
        orderBy: { confidence: 'desc' },
        take: 5,
      }),
    ]);

    if (!agent) return null;

    const completed = recentTasks.filter(t => t.status === 'completed').length;
    const failed = recentTasks.filter(t => t.status === 'failed').length;

    return {
      agent,
      activeTasks,
      recentTasks,
      recentDecisions,
      knowledge,
      stats: {
        tasksRun: recentTasks.length,
        completed,
        failed,
        successRate: recentTasks.length > 0 ? completed / recentTasks.length : 0,
        currentlyBusy: activeTasks.length > 0,
      },
    };
  }

  // ============================================================
  // AGENT-TO-AGENT COMMUNICATION
  // ============================================================

  /**
   * Send a message from one agent to another.
   * This is how orchestrators coordinate across companies.
   */
  async sendAgentMessage({ fromAgentId, toAgentId, content, metadata = null, type = 'info' }) {
    return prisma.agentMessage.create({
      data: { fromAgentId, toAgentId, content, metadata, type },
    });
  }

  /**
   * Get unread messages for an agent.
   */
  async getUnreadMessages(agentId) {
    return prisma.agentMessage.findMany({
      where: { toAgentId: agentId, read: false },
      include: { fromAgent: { select: { name: true, role: true, company: { select: { name: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Get recent messages between two agents.
   */
  async getAgentConversation(agentId1, agentId2, limit = 20) {
    return prisma.agentMessage.findMany({
      where: {
        OR: [
          { fromAgentId: agentId1, toAgentId: agentId2 },
          { fromAgentId: agentId2, toAgentId: agentId1 },
        ],
      },
      include: { fromAgent: { select: { name: true } }, toAgent: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Mark messages as read.
   */
  async markMessagesRead(agentId) {
    return prisma.agentMessage.updateMany({
      where: { toAgentId: agentId, read: false },
      data: { read: true },
    });
  }

  // ============================================================
  // TASK CHAINING — One agent's output feeds another's input
  // ============================================================

  /**
   * Create a chained task — links to a parent task's output.
   */
  async createChainedTask({ prompt, agentId, repoId, companyId, model, parentTaskId }) {
    return prisma.taskLog.create({
      data: { prompt, agentId, repoId, companyId, model, parentTaskId, status: 'running' },
    });
  }

  /**
   * Get the full chain of tasks (parent → children).
   */
  async getTaskChain(taskId) {
    const task = await prisma.taskLog.findUnique({
      where: { id: taskId },
      include: {
        agent: { select: { name: true, role: true } },
        childTasks: {
          include: { agent: { select: { name: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return task;
  }

  /**
   * Get all child tasks waiting on a parent.
   */
  async getPendingChainedTasks(parentTaskId) {
    return prisma.taskLog.findMany({
      where: { parentTaskId, status: 'pending' },
      include: { agent: { select: { name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ============================================================
  // KNOWLEDGE DECAY — Scheduled maintenance
  // ============================================================

  /**
   * Start the weekly knowledge decay cycle.
   * Runs immediately once, then every 7 days.
   */
  startDecayCycle() {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    const runDecay = async () => {
      try {
        const result = await this.decayKnowledge();
        if (result.count > 0) {
          console.log(`[Memory] Knowledge decay: ${result.count} entries decayed`);
        }
      } catch (e) {
        console.warn(`[Memory] Knowledge decay failed: ${e.message}`);
      }
    };

    // Run once on startup (after a short delay to let DB connect)
    setTimeout(runDecay, 5000);

    // Then weekly
    this._decayInterval = setInterval(runDecay, WEEK_MS);
    console.log('[Memory] Knowledge decay scheduled (weekly)');
  }

  /**
   * Stop the decay cycle (for clean shutdown).
   */
  stopDecayCycle() {
    if (this._decayInterval) {
      clearInterval(this._decayInterval);
      this._decayInterval = null;
    }
  }

  // ============================================================
  // SUMMARY — What Sky needs to know right now
  // ============================================================

  // ============================================================
  // SEMANTIC SEARCH — The smart way to find relevant memories
  // ============================================================

  /**
   * Search all memory types using semantic similarity.
   * Falls back to keyword search if embeddings aren't ready.
   *
   * @param {string} query - Natural language query
   * @param {number} limit - Max results
   * @param {string|null} sourceType - Filter: "conversation", "decision", "knowledge", or null for all
   * @returns {Array<{sourceType, sourceId, content, similarity, record}>}
   */
  async semanticSearch(query, limit = 10, sourceType = null, scope = null) {
    try {
      // Phase 1 (Stage D): forward scope to the embedding cache. When the
      // SKY_PHASE1_SCOPE flag is on AND a scope is provided, candidates are
      // pre-cosine filtered to chat/entity/global matches.
      const results = await embeddings.searchSimilar(query, limit, sourceType, scope);

      // Fetch the actual records from their source tables
      const enriched = await Promise.all(
        results.map(async (result) => {
          let record = null;
          try {
            switch (result.sourceType) {
              case 'conversation':
                record = await prisma.conversation.findUnique({ where: { id: result.sourceId } });
                break;
              case 'decision':
                record = await prisma.decision.findUnique({ where: { id: result.sourceId } });
                break;
              case 'knowledge':
                record = await prisma.knowledge.findUnique({ where: { id: result.sourceId } });
                break;
            }
          } catch (e) {
            // Record may have been deleted — skip it
          }

          if (!record) return null;

          return {
            sourceType: result.sourceType,
            sourceId: result.sourceId,
            content: result.content,
            similarity: result.similarity,
            record,
          };
        })
      );

      return enriched.filter(Boolean);
    } catch (err) {
      console.warn(`[Memory] Semantic search failed, falling back to keyword search: ${err.message}`);

      // Fallback: keyword search across knowledge
      const keywords = query.split(' ').filter(w => w.length > 3).slice(0, 3);
      const fallbackResults = [];
      for (const keyword of keywords) {
        const knowledge = await this.searchKnowledge({ query: keyword, limit: Math.ceil(limit / 3) });
        fallbackResults.push(
          ...knowledge.map(k => ({
            sourceType: 'knowledge',
            sourceId: k.id,
            content: `${k.title} ${k.content}`,
            similarity: 0,
            record: k,
          }))
        );
      }
      return fallbackResults.slice(0, limit);
    }
  }

  /**
   * Get a snapshot of the current state for Sky's context.
   */
  async getCurrentState() {
    const [
      recentConversations,
      pendingDecisions,
      recentKnowledge,
      taskStats,
      pendingFunding,
    ] = await Promise.all([
      this.getRecentConversations({ limit: 10 }),
      this.getDecisionsDueForReview(),
      this.searchKnowledge({ limit: 5 }),
      this.getTaskStats(),
      prisma.fundingRequest.findMany({ where: { status: 'pending' } }),
    ]);

    return {
      recentConversations,
      pendingDecisions,
      recentKnowledge,
      taskStats,
      pendingFunding,
    };
  }
}

export default new Memory();
