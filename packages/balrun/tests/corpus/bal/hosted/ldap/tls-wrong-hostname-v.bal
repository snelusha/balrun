import ballerina/io;
import ballerina/ldap;

public function main() {
    ldap:Client|ldap:Error c = new ({hostName: "127.0.0.1", port: 19622, domainName: "cn=admin", password: "pw", clientSecureSocket: {cert: "ca.pem"}});
    io:println(c is ldap:Error && c.message().includes("x509")); // @output true
}
