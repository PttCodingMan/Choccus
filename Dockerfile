# ---- build client/dist with Node ----
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm install && npm run build

# ---- run relay + static server with Python ----
FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server/ server/
COPY shared/ shared/
COPY --from=build /app/client/dist client/dist
EXPOSE 8080 8765
CMD ["python", "server/serve.py"]
