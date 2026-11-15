// Synthetic data for UI verification. Not included in the extension package.
const platform =
  new URLSearchParams(location.search).get("platform") || "instagram";
window.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: {
    sendMessage: async ({ request }) => {
      await new Promise((r) => setTimeout(r, 150));
      if (request.kind === "context")
        return {
          ok: true,
          platform,
          warnings:
            platform === "whatsapp"
              ? [
                  "WhatsApp fixture: media downloads and transcription are unavailable.",
                ]
              : [],
          threadId: "123456789",
          title: "Fixture conversation",
        };
      const offset = request.cursor ? 20 : 0;
      const result = {
        ok: true,
        viewerId: "1",
        connection: {
          edges: Array.from({ length: 20 }, (_, i) => ({
            node: {
              id: String(offset + i),
              timestamp_ms: Date.now() - (offset + i) * 60000,
              text_body:
                i === 3
                  ? 'Literal markup: <script>alert("test")</script>'
                  : i % 2
                    ? "Sounds good. See you there!"
                    : "Want to grab coffee this weekend?",
              sender_fbid: i % 2 ? "1" : "2",
              sender: {
                name: i % 2 ? "You" : "Friend",
                user_dict: { id: i % 2 ? "1" : "2" },
              },
            },
          })),
          page_info: {
            has_next_page: !offset,
            end_cursor: offset ? null : "page-2",
          },
        },
      };
      if (platform === "whatsapp")
        return {
          ok: true,
          page: {
            messages: result.connection.edges.map(({ node }) => ({
              id: node.id,
              timestamp: node.timestamp_ms,
              senderId: node.sender_fbid,
              sender: node.sender.name,
              isMe: node.sender_fbid === "1",
              text: node.text_body,
              type: "chat",
              reactions: [],
              attachments: [],
              raw: node,
            })),
            hasMore: result.connection.page_info.has_next_page,
            nextCursor: result.connection.page_info.end_cursor,
          },
        };
      return result;
    },
  },
};
