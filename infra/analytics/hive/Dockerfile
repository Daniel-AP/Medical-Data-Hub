FROM apache/hive:4.0.1

USER root
ADD --chmod=644 https://repo.maven.apache.org/maven2/org/postgresql/postgresql/42.7.14/postgresql-42.7.14.jar /opt/hive/lib/postgresql.jar
RUN install -d -m 1777 /warehouse
COPY metastore-site.xml /opt/hive-custom-conf/
USER hive
