import ballerina/io;

public function main() returns error? {
    string[] lines = ["first", "second"];
    check io:fileWriteLinesFromStream("out/lines.txt", lines.toStream());
    string[] more = ["third"];
    check io:fileWriteLinesFromStream("out/lines.txt", more.toStream(), io:APPEND);

    stream<string, io:Error?> read = check io:fileReadLinesAsStream("out/lines.txt");
    record {|string value;|}? line = check read.next();
    while line != () {
        io:println(line.value);
        line = check read.next();
    }

    stream<io:Block, io:Error?> blocks = check io:fileReadBlocksAsStream("out/lines.txt", 8);
    record {|io:Block value;|}? block = check blocks.next();
    while block != () {
        io:println(block.value.length());
        block = check blocks.next();
    }

    stream<io:Block, io:Error?> open = check io:fileReadBlocksAsStream("out/lines.txt", 8);
    _ = check open.next();
}
