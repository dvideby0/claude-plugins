package com.example.auth;

import java.util.Map;
import java.util.HashMap;
import com.example.utils.Validator;

public class LoginService {

    private Map<String, String> tokens;

    public LoginService() {
        this.tokens = new HashMap<>();
    }

    public String authenticate(String username, String password) {
        return "token";
    }

    private boolean validatePassword(String password) {
        return password != null && password.length() > 8;
    }
}

public interface AuthProvider {
    String getToken(String user);
}

public enum AuthRole {
    ADMIN,
    USER,
    GUEST
}
