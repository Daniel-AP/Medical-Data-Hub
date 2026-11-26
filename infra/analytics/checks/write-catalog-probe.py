from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("catalog-probe").enableHiveSupport().getOrCreate()
try:
	spark.createDataFrame([(42,)], "marker INT").write.format("parquet").saveAsTable("default.catalog_probe")
finally:
	spark.stop()
