FROM node:16-alpine

WORKDIR /github/workspace

COPY ./package.json ./package.json
COPY ./package-lock.json ./package-lock.json

RUN apk add --update openssh

RUN echo "${INPUT_SSH-KEY}" >> key.pem
RUN chmod 400 key.pem

RUN npm i

COPY ./main.js ./main.js

ENTRYPOINT [ "node", "main.js" ]