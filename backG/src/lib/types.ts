import axios from "axios";
export const typeDefs = `#graphql
type Todo{
  id : ID!
  title: String!
  completed: Boolean!
}
type Query{
  getTodos: [Todo]
  getSpecificTodo(id:ID!):Todo
}
`; //These are the schemas just like in express we define routes
export const resolvers = {
  Query: {
    getTodos: async () => {
      const result = await axios.get(
        "https://jsonplaceholder.typicode.com/todos",
      );
      return result.data;
    },
    getSpecificTodo: async (parent: any, { id }: { id: Number }) => {
      const result = await axios.get(
        `https://jsonplaceholder.typicode.com/todos/${id}`,
      );
      return result.data;
    },
  },
};
