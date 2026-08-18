# Stage 1: Build ứng dụng Spring Boot ra file .jar
# Pinned version of maven:3.9.8-eclipse-temurin-21
FROM maven@sha256:de18e4e51396ad9266f76669779ed6d6b49fbb0f45ed6f39169d87378d548d7d AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn clean package -DskipTests

# Stage 2: Chạy ứng dụng với JRE siêu nhẹ và bảo mật cao
# Chuyển sang dùng Alpine thay vì Jammy (Ubuntu) để giảm tối đa kích thước và lỗ hổng bảo mật
FROM eclipse-temurin@sha256:3f08b13888f595cc49edabea7250ba69499ba25602b267da591720769400e08c
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
