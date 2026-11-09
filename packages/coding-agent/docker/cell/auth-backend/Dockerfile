FROM node:24.11.0-alpine

RUN addgroup -S cell && adduser -S -G cell cell
WORKDIR /app
COPY --chown=cell:cell server.mjs /app/server.mjs
USER cell
EXPOSE 4010
CMD ["node", "/app/server.mjs"]
