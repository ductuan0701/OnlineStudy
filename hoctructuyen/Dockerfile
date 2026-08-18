# Stage 1: Build ứng dụng Spring Boot ra file .jar
# Pinned version of maven:3.9.8-eclipse-temurin-21
FROM maven@sha256:c2ba0f1712a8af3c72688008e4aa7338515ce920a6727dc00e3b6fb89191d8a1 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn clean package -DskipTests

# Stage 2: Chạy ứng dụng với JRE siêu nhẹ
# Pinned version of eclipse-temurin:21-jre-jammy
FROM eclipse-temurin@sha256:2cececd3b08ef5c49b6ce8fbccbe8041cbf06cecdfa0a48a9ce5678822002717
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
