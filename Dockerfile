FROM node:16-alpine

COPY ./package.json ./package.json
COPY ./package-lock.json ./package-lock.json

RUN apk add --update openssh

RUN echo "${INPUT_SSH_KEY_$INPUT_ENV}" >> key.pem
RUN chmod 400 key.pem

RUN npm i

COPY ./main.js ./main.js

CMD [ "node", "main.js" ]