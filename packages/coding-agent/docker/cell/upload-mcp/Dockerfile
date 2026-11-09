FROM node:24.11.0-alpine

RUN addgroup -S mcp && adduser -S -G mcp mcp && mkdir -p /data/uploads && chown mcp:mcp /data/uploads
WORKDIR /app
COPY --chown=mcp:mcp server.mjs /app/server.mjs
USER mcp
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
