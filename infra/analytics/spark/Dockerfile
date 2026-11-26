FROM apache/hive:4.0.1 AS hive
FROM apache/spark:4.0.5-python3

USER root
RUN install -d -m 1777 /warehouse
COPY --from=hive /opt/hive/lib/ /opt/hive-client/
COPY spark-defaults.conf /opt/spark/conf/
USER spark
