import ballerina/io;
import ballerina/ldap;

public function main() {
    ldap:Client|ldap:Error c = new ({hostName: "127.0.0.1", port: 19607, domainName: "cn=admin", password: "pw"});
    io:println(c is ldap:Error && c.message().includes("connection refused")); // @output true
}
