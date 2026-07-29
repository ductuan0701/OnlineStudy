package com.dan.util;

import com.dan.model.Role;
import com.dan.model.RoleName;
import com.dan.model.User;
import com.dan.repository.RoleRepository;
import com.dan.repository.UserRepository;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.Set;

@Component
public class RoleInsert {
    @Bean
    public CommandLineRunner demo(RoleRepository roleRepository, UserRepository userRepository, PasswordEncoder passwordEncoder) {
        return (args) -> {
            Role adminRole = roleRepository.findByName(RoleName.ADMIN).orElseGet(() -> {
                Role role = new Role();
                role.setName(RoleName.ADMIN);
                return roleRepository.save(role);
            });

            Role teacherRole = roleRepository.findByName(RoleName.TEACHER).orElseGet(() -> {
                Role role = new Role();
                role.setName(RoleName.TEACHER);
                return roleRepository.save(role);
            });

            Role studentRole = roleRepository.findByName(RoleName.STUDENT).orElseGet(() -> {
                Role role = new Role();
                role.setName(RoleName.STUDENT);
                return roleRepository.save(role);
            });

            if (!userRepository.existsByUsername("admin123")) {
                User adminUser = new User();
                adminUser.setName("Administrator");
                adminUser.setUsername("admin123");
                adminUser.setPassword(passwordEncoder.encode("admin123"));
                adminUser.setEmail("admin@hoclaptrinh.top");
                Set<Role> roles = new HashSet<>();
                roles.add(adminRole);
                adminUser.setRoles(roles);
                userRepository.save(adminUser);
            }
        };
    }
}
