FROM alpine:3.20

RUN apk add --no-cache curl postgresql16-client tzdata

COPY scheduler.sh /usr/local/bin/scheduler.sh
RUN chmod +x /usr/local/bin/scheduler.sh

CMD ["/usr/local/bin/scheduler.sh"]
