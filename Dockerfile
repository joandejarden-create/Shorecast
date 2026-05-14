# Optional: deploy this repo on Railway (static + serve on $PORT)
FROM node:22-alpine
WORKDIR /site
RUN npm install -g serve@14.2.4
COPY index.html ./
COPY css/shorecast.css ./css/shorecast.css
COPY js/shorecast.js ./js/shorecast.js
CMD ["sh", "-c", "exec serve -s . -l \"${PORT:-3000}\""]
