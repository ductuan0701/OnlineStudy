package com.dan;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

@SpringBootApplication
public class HoctructuyenApplication {

    public static void main(String[] args) {
        // GIẢ LẬP LỖI NGHIÊM TRỌNG KHI KHỞI ĐỘNG (FATAL ERROR)
        if (true) {
            throw new RuntimeException("Fatal Error: Không thể khởi động ứng dụng do sai cấu hình Database!");
        }
        SpringApplication.run(HoctructuyenApplication.class, args);
    }

}
